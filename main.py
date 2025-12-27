import asyncio
import json
import ssl
import aiohttp
import certifi
import decky

GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"

OP_DISPATCH = 0
OP_HEARTBEAT = 1
OP_IDENTIFY = 2
OP_PRESENCE_UPDATE = 3
OP_HELLO = 10
OP_HEARTBEAT_ACK = 11

class DiscordGateway:
    def __init__(self, token):
        self.token = token
        self.ws = None
        self.session = None
        self.heartbeat_interval = None
        self.sequence = None
        self.heartbeat_task = None
        self.connected = False
        self.current_activity = None
        self.user = None

    async def connect(self):
        try:
            decky.logger.info("Creating WebSocket connection...")
            ssl_context = ssl.create_default_context(cafile=certifi.where())
            self.session = aiohttp.ClientSession()
            self.ws = await self.session.ws_connect(GATEWAY_URL, ssl=ssl_context)
            decky.logger.info("WebSocket connected")
            
            hello = await self.ws.receive_json()
            decky.logger.info(f"Received hello: op={hello.get('op')}")
            if hello.get("op") != OP_HELLO:
                decky.logger.error(f"Expected HELLO, got: {hello}")
                await self.close()
                return False
            
            self.heartbeat_interval = hello["d"]["heartbeat_interval"] / 1000
            decky.logger.info(f"Heartbeat interval: {self.heartbeat_interval}s")
            
            await self.ws.send_json({"op": OP_HEARTBEAT, "d": None})
            decky.logger.info("Sent initial heartbeat")
            
            await self._identify()
            decky.logger.info("Sent IDENTIFY")
            
            self.heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            
            for i in range(10):
                try:
                    msg = await asyncio.wait_for(self.ws.receive(), timeout=30.0)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        response = json.loads(msg.data)
                        decky.logger.info(f"Gateway response #{i}: op={response.get('op')} t={response.get('t')}")
                        
                        if response.get("s"):
                            self.sequence = response.get("s")
                        
                        if response.get("op") == OP_DISPATCH and response.get("t") == "READY":
                            self.connected = True
                            self.user = response.get("d", {}).get("user", {})
                            decky.logger.info(f"Connected as {self.user.get('username')}")
                            return True
                        
                        if response.get("op") == 9:
                            decky.logger.error("Invalid session - token may be invalid")
                            await self.close()
                            return False
                    elif msg.type == aiohttp.WSMsgType.CLOSED:
                        decky.logger.error("WebSocket closed unexpectedly")
                        await self.close()
                        return False
                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        decky.logger.error(f"WebSocket error: {msg.data}")
                        await self.close()
                        return False
                except asyncio.TimeoutError:
                    decky.logger.error("Timeout waiting for Gateway response")
                    await self.close()
                    return False
            
            decky.logger.error("Did not receive READY event after 10 messages")
            await self.close()
            return False
        except Exception as e:
            decky.logger.error(f"Gateway connection error: {e}")
            await self.close()
            return False

    async def _identify(self):
        payload = {
            "op": OP_IDENTIFY,
            "d": {
                "token": self.token,
                "properties": {
                    "os": "linux",
                    "browser": "steamdeck-discord-status",
                    "device": "steamdeck-discord-status"
                },
                "presence": {
                    "activities": [],
                    "status": "online",
                    "since": 0,
                    "afk": False
                }
            }
        }
        await self.ws.send_json(payload)

    async def _heartbeat_loop(self):
        try:
            while self.connected or self.ws:
                await asyncio.sleep(self.heartbeat_interval)
                if self.ws and not self.ws.closed:
                    await self.ws.send_json({
                        "op": OP_HEARTBEAT,
                        "d": self.sequence
                    })
        except asyncio.CancelledError:
            pass
        except Exception as e:
            decky.logger.error(f"Heartbeat error: {e}")

    async def update_presence(self, activity):
        if not self.ws or self.ws.closed:
            return False
        
        self.current_activity = activity
        
        activities = []
        if activity:
            game_activity = {
                "name": activity["details"]["name"],
                "type": 0,
                "timestamps": {
                    "start": activity["startTime"]
                }
            }
            
            if "imageUrl" in activity and activity["imageUrl"]:
                game_activity["assets"] = {
                    "large_image": activity["imageUrl"]
                }
            
            activities.append(game_activity)
        
        payload = {
            "op": OP_PRESENCE_UPDATE,
            "d": {
                "since": 0,
                "activities": activities,
                "status": "online",
                "afk": False
            }
        }
        
        try:
            await self.ws.send_json(payload)
            decky.logger.info(f"Presence updated: {activity['details']['name'] if activity else 'cleared'}")
            return True
        except Exception as e:
            decky.logger.error(f"Failed to update presence: {e}")
            return False

    async def close(self):
        self.connected = False
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
            try:
                await self.heartbeat_task
            except asyncio.CancelledError:
                pass
            self.heartbeat_task = None
        if self.ws:
            await self.ws.close()
            self.ws = None
        if self.session:
            await self.session.close()
            self.session = None

class Plugin:
    def __init__(self):
        self.gateway = None
        self.token = None

    async def set_token(self, token):
        self.token = token
        return True

    async def get_token(self):
        return self.token or ""

    async def connect(self):
        decky.logger.info("Connect called")
        if not self.token:
            decky.logger.error("No token set")
            return False
        
        decky.logger.info(f"Connecting with token length: {len(self.token)}")
        
        if self.gateway:
            await self.gateway.close()
        
        self.gateway = DiscordGateway(self.token)
        result = await self.gateway.connect()
        decky.logger.info(f"Connection result: {result}")
        return result

    async def is_connected(self):
        return self.gateway is not None and self.gateway.connected

    async def get_user(self):
        if self.gateway and self.gateway.user:
            return self.gateway.user
        return None

    async def clear_activity(self):
        if not self.gateway or not self.gateway.connected:
            return False
        
        result = await self.gateway.update_presence(None)
        return result

    async def update_activity(self, activity):
        if not self.gateway or not self.gateway.connected:
            connected = await self.connect()
            if not connected:
                return False
        
        result = await self.gateway.update_presence(activity)
        return result

    async def disconnect(self):
        if self.gateway:
            await self.gateway.close()
            self.gateway = None
        decky.logger.info("Disconnected from Discord")

    async def _main(self):
        decky.logger.info("Starting Discord status plugin")

    async def _unload(self):
        await self.disconnect()
