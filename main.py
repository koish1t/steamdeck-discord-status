import asyncio
import json
import ssl
import aiohttp
import certifi
import decky

GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"
DEFAULT_APP_ID = "1055680235682672682"

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
        self.connected = False
        self.user = None
        self.last_heartbeat_ack = True
        self._closing = False

    async def connect(self):
        self._closing = False
        try:
            ssl_context = ssl.create_default_context(cafile=certifi.where())
            self.session = aiohttp.ClientSession()
            self.ws = await self.session.ws_connect(GATEWAY_URL, ssl=ssl_context, heartbeat=30.0)
            
            hello = await self.ws.receive_json()
            if hello.get("op") != OP_HELLO:
                await self.close()
                return False
            
            self.heartbeat_interval = hello["d"]["heartbeat_interval"] / 1000
            
            await self.ws.send_json({"op": OP_HEARTBEAT, "d": None})
            await self._identify()
            
            for _ in range(10):
                try:
                    msg = await asyncio.wait_for(self.ws.receive(), timeout=30.0)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        response = json.loads(msg.data)
                        if response.get("s"):
                            self.sequence = response.get("s")
                        if response.get("op") == OP_DISPATCH and response.get("t") == "READY":
                            self.connected = True
                            self.user = response.get("d", {}).get("user", {})
                            decky.logger.info(f"Connected as {self.user.get('username')}")
                            return True
                        if response.get("op") == 9:
                            await self.close()
                            return False
                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        await self.close()
                        return False
                except asyncio.TimeoutError:
                    await self.close()
                    return False
            
            await self.close()
            return False
        except Exception as e:
            decky.logger.error(f"Gateway connection error: {e}")
            await self.close()
            return False

    async def _identify(self):
        await self.ws.send_json({
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
        })

    async def send_heartbeat(self):
        if self.ws and not self.ws.closed and not self._closing:
            try:
                await self.ws.send_json({"op": OP_HEARTBEAT, "d": self.sequence})
                return True
            except:
                return False
        return False

    async def receive_messages(self):
        if not self.ws or self.ws.closed or self._closing:
            return False
        
        try:
            msg = await asyncio.wait_for(self.ws.receive(), timeout=5.0)
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data.get("s"):
                    self.sequence = data.get("s")
                if data.get("op") == OP_HEARTBEAT_ACK:
                    self.last_heartbeat_ack = True
                elif data.get("op") in (7, 9):
                    return False
            elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                return False
        except asyncio.TimeoutError:
            pass
        except:
            return False
        return True

    async def update_presence(self, activity):
        if not self.ws or self.ws.closed or self._closing:
            return False
        
        activities = []
        if activity:
            discord_id = activity.get("discordId")
            game_name = activity["details"]["name"]
            
            if discord_id:
                game_activity = {
                    "name": game_name,
                    "type": 0,
                    "application_id": discord_id,
                    "timestamps": {"start": activity["startTime"]},
                    "details": "on Steam Deck",
                    "assets": {
                        "large_image": activity.get("imageUrl", "steamdeck"),
                        "large_text": game_name,
                        "small_image": "https://cdn.discordapp.com/app-assets/1055680235682672682/1056080943783354388.png",
                        "small_text": "Steam Deck"
                    }
                }
            else:
                game_activity = {
                    "name": game_name,
                    "type": 0,
                    "application_id": DEFAULT_APP_ID,
                    "timestamps": {"start": activity["startTime"]},
                    "state": "on Steam Deck",
                    "details": f"Playing {game_name}"
                }
                if activity.get("imageUrl"):
                    game_activity["assets"] = {
                        "large_image": activity["imageUrl"],
                        "large_text": game_name
                    }
            
            activities.append(game_activity)
        
        try:
            await self.ws.send_json({
                "op": OP_PRESENCE_UPDATE,
                "d": {
                    "since": 0,
                    "activities": activities,
                    "status": "online",
                    "afk": False
                }
            })
            return True
        except Exception as e:
            decky.logger.error(f"Failed to update presence: {e}")
            return False

    async def close(self):
        self._closing = True
        self.connected = False
        if self.ws:
            try:
                await self.ws.close()
            except:
                pass
            self.ws = None
        if self.session:
            try:
                await self.session.close()
            except:
                pass
            self.session = None

class Plugin:
    def __init__(self):
        self.gateway = None
        self.token = None
        self.current_activity = None
        self.keep_alive_task = None
        self.reconnecting = False

    async def set_token(self, token):
        self.token = token
        return True

    async def get_token(self):
        return self.token or ""

    async def _keep_alive_loop(self):
        heartbeat_counter = 0
        while True:
            try:
                await asyncio.sleep(10)
                
                if not self.gateway or not self.gateway.connected:
                    if not self.reconnecting and self.token:
                        decky.logger.info("Connection lost, reconnecting...")
                        await self._reconnect()
                    continue
                
                ok = await self.gateway.receive_messages()
                if not ok:
                    decky.logger.info("Receive failed, reconnecting...")
                    await self._reconnect()
                    continue
                
                heartbeat_counter += 1
                if self.gateway and heartbeat_counter * 10 >= self.gateway.heartbeat_interval:
                    heartbeat_counter = 0
                    if not self.gateway.last_heartbeat_ack:
                        decky.logger.info("No heartbeat ACK, reconnecting...")
                        await self._reconnect()
                        continue
                    self.gateway.last_heartbeat_ack = False
                    if not await self.gateway.send_heartbeat():
                        decky.logger.info("Heartbeat failed, reconnecting...")
                        await self._reconnect()
                        
            except asyncio.CancelledError:
                break
            except Exception as e:
                decky.logger.error(f"Keep-alive error: {e}")
                await asyncio.sleep(5)

    async def _reconnect(self):
        if self.reconnecting:
            return
        self.reconnecting = True
        
        try:
            for attempt in range(5):
                decky.logger.info(f"Reconnect attempt {attempt + 1}/5")
                if self.gateway:
                    await self.gateway.close()
                
                self.gateway = DiscordGateway(self.token)
                if await self.gateway.connect():
                    decky.logger.info("Reconnected successfully")
                    if self.current_activity:
                        await self.gateway.update_presence(self.current_activity)
                    break
                
                await asyncio.sleep(5 * (attempt + 1))
        finally:
            self.reconnecting = False

    async def connect(self):
        if not self.token:
            return False
        
        if self.gateway:
            await self.gateway.close()
        
        self.gateway = DiscordGateway(self.token)
        result = await self.gateway.connect()
        
        if result and not self.keep_alive_task:
            self.keep_alive_task = asyncio.create_task(self._keep_alive_loop())
        
        return result

    async def is_connected(self):
        return self.gateway is not None and self.gateway.connected

    async def get_user(self):
        if self.gateway and self.gateway.user:
            return self.gateway.user
        return None

    async def clear_activity(self):
        self.current_activity = None
        if not self.gateway or not self.gateway.connected:
            return False
        return await self.gateway.update_presence(None)

    async def update_activity(self, activity):
        self.current_activity = activity
        if not self.gateway or not self.gateway.connected:
            connected = await self.connect()
            if not connected:
                return False
        return await self.gateway.update_presence(activity)

    async def disconnect(self):
        if self.keep_alive_task:
            self.keep_alive_task.cancel()
            try:
                await self.keep_alive_task
            except asyncio.CancelledError:
                pass
            self.keep_alive_task = None
        if self.gateway:
            await self.gateway.close()
            self.gateway = None

    async def _main(self):
        decky.logger.info("Starting Discord status plugin")

    async def _unload(self):
        await self.disconnect()
