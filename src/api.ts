import { Router, sleep } from '@decky/ui';
import { callable, toaster } from '@decky/api';
import { EventEmitter } from 'eventemitter3';
import { logger } from './util';
import { AppOverview, AppType, Hook } from './SteamClient';
import { AppLifetimeNotification } from '@decky/ui/dist/globals/steam-client/GameSessions';
import { ESuspendResumeProgressState, SuspendProgress } from '@decky/ui/dist/globals/steam-client/User';

const log = logger('API');

enum StorageKeys {
    Activities = 'discord-status:activities',
    DetectableCache = 'discord-status:apps',
    DiscordToken = 'discord-status:token',
    RunningActivity = 'discord-status:running-activity',
    SuspendTime = 'discord-status:suspend-time'
}

export interface Activity {
    appId: string;
    details: {
        name: string;
    };
    discordId?: string;
    startTime: number;
    imageUrl: string;
    localImageUrl: string;
}

interface DiscordDetectableApplication {
    id: string;
    name: string;
}

export interface DiscordUser {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    global_name: string | null;
}

export enum Event {
    connect = 'connect',
    connecting = 'connecting',
    disconnect = 'disconnect',
    update = 'update',
    tokenSet = 'token-set',
    userSet = 'user-set'
}

export class Api extends EventEmitter {
    private static instance: Api;

    private _clearActivity = callable<[], boolean>('clear_activity');
    private _connect = callable<[], boolean>('connect');
    private _disconnect = callable<[], boolean>('disconnect');
    private _isConnected = callable<[], boolean>('is_connected');
    private _setToken = callable<[string], boolean>('set_token');
    private _getUser = callable<[], DiscordUser | null>('get_user');
    private _updateActivity = callable<[Activity], boolean>('update_activity');

    private _activities: {
        [appId: string]: Activity;
    };
    public get activities() {
        return this._activities;
    }

    private _connected: boolean = false;
    public get connected() {
        return this._connected;
    }

    private _token: string = '';
    public get token() {
        return this._token;
    }

    private _user: DiscordUser | null = null;
    public get user() {
        return this._user;
    }

    private _runningActivity: string | null;
    public get runningActivity(): Activity | null {
        if (this._runningActivity) {
            return this._activities[this._runningActivity];
        }
        return null;
    }
    private set runningActivity(activity: Activity | null) {
        if (activity) {
            this._runningActivity = activity.appId || '0';
        } else {
            this._runningActivity = null;
        }
    }

    private hooks: Hook[];

    private constructor() {
        super();

        this._activities = {};
        this._runningActivity = null;
        this.hooks = [];

        this.hooks.push(
            SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
                this.onAppLifetimeNotification.bind(this)
            )
        );

        this.hooks.push(
            SteamClient.User.RegisterForResumeSuspendedGamesProgress(this.onResume.bind(this))
        );
        this.hooks.push(SteamClient.User.RegisterForPrepareForSystemSuspendProgress(this.onSuspend.bind(this)));

        this.loadToken();
        this.loadDetectableDiscordApps();
        this.updateActivityState();
    }

    public static initialize() {
        Api.instance = new Api();
        return Api.instance;
    }

    private async loadDetectableDiscordApps() {
        const cached = window.localStorage.getItem(StorageKeys.DetectableCache);

        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Date.now() - parsed.lastFetch < 1000 * 60 * 60 * 24) {
                    return parsed.applications;
                }
            } catch {}
        }

        try {
            const response = await fetch('https://discord.com/api/v10/applications/detectable');
            const data = await response.json();

            window.localStorage.setItem(StorageKeys.DetectableCache, JSON.stringify({
                lastFetch: Date.now(),
                applications: data
            }));

            return data;
        } catch {
            return [];
        }
    }

    private async loadToken() {
        const storedToken = window.localStorage.getItem(StorageKeys.DiscordToken);
        if (storedToken) {
            this._token = storedToken;
            await this._setToken(storedToken);
            this.emit(Event.tokenSet, storedToken);
        }
    }

    public async setToken(token: string): Promise<boolean> {
        this._token = token;
        window.localStorage.setItem(StorageKeys.DiscordToken, token);
        const result = await this._setToken(token);
        this.emit(Event.tokenSet, token);
        return result;
    }

    public async checkConnection(): Promise<boolean> {
        if (!this._token) {
            log('No token set');
            this.emit(Event.disconnect);
            return false;
        }

        log('Checking connection');
        this.emit(Event.connecting);

        this._connected = await this._isConnected();

        if (!this._connected) {
            this._connected = await this._connect();
        }

        if (this._connected) {
            log('Connected');
            this._user = await this._getUser();
            this.emit(Event.connect);
            this.emit(Event.userSet, this._user);

            if (this.runningActivity) {
                await this.updateActivity(this.runningActivity);
            }
        } else {
            log('Disconnected');
            this.emit(Event.disconnect);
        }

        await this.updateActivityState();
        if (this.runningActivity) {
            await this.updateActivity(this.runningActivity);
        }

        return this._connected;
    }

    public async disconnect(): Promise<void> {
        log('Disconnecting');

        await this._disconnect();

        this._connected = false;
        this._user = null;
        this.emit(Event.disconnect);
        this.emit(Event.userSet, null);
    }

    public unregister(): void {
        this._connected = false;
        this.hooks.forEach((hook) => hook.unregister());
    }

    public async clearActivity(): Promise<boolean> {
        const appId = this.runningActivity?.appId;
        this.runningActivity = null;

        if (!this._connected) {
            log('Not connected, not clearing activity');
            return false;
        }

        log('Clearing activity', appId);
        const result = await this._clearActivity();

        this.emit('update');

        return result;
    }

    public async updateActivity(activity: Activity | null): Promise<boolean> {
        if (!activity) {
            return this.clearActivity();
        }

        this.runningActivity = activity;

        if (!this._connected) {
            log('Not connected, not updating activity');
            return false;
        }

        log('Updating activity', activity);
        const result = await this._updateActivity(activity);

        if (result) {
            this.emit('update');
            return true;
        }

        log('Failed to update activity', result);
        return false;
    }

    public async updateActivityState(): Promise<void> {
        for (const app of Router.RunningApps) {
            const appId = app.appid.toString();
            const gameInfo = appStore.GetAppOverviewByGameID(appId);

            log('Initializing with activity', appId, gameInfo.display_name);
            this.activities[appId.toString()] = this.convertAppOverviewToActivity(gameInfo);
        }

        if (Router.MainRunningApp && !this._runningActivity) {
            log('Setting running activity to', Router.MainRunningApp.appid.toString());
            this._runningActivity = Router.MainRunningApp.appid.toString();
        }
    }

    private convertAppOverviewToActivity(appInfo: AppOverview, startTime?: Date): Activity {
        let image =
            appInfo.app_type === AppType.Shortcut
                ? 'https://cdn.discordapp.com/app-assets/1055680235682672682/1057044202631987340.png'
                : appStore.GetVerticalCapsuleURLForApp(appInfo);
        let localImageUrl = image;
        if (appInfo.app_type === AppType.Shortcut) {
            const urls = appStore.GetCustomVerticalCapsuleURLs(appInfo);
            if (urls.length) {
                localImageUrl = urls[urls.length - 1];
            }
        }

        let discordId: string | undefined = undefined;
        const detectableCached = window.localStorage.getItem(StorageKeys.DetectableCache);
        if (detectableCached) {
            try {
                const detectable = JSON.parse(detectableCached);
                const found = detectable.applications?.find(
                    (app: DiscordDetectableApplication) => app.name === appInfo.display_name
                );
                if (found) {
                    discordId = found.id;
                }
            } catch {}
        }

        return {
            appId: appInfo.appid.toString(),
            details: {
                name: appInfo.display_name
            },
            discordId,
            startTime: startTime?.getTime() ?? Date.now(),
            imageUrl: image,
            localImageUrl: localImageUrl
        };
    }

    protected async onAppLifetimeNotification(app: AppLifetimeNotification) {
        const gameId = app.unAppID.toString();
        const gameInfo = appStore.GetAppOverviewByGameID(gameId);

        if (app.bRunning) {
            const activity = this.convertAppOverviewToActivity(gameInfo);
            this._activities[gameId] = activity;

            const previousRunning = this.runningActivity;

            this._runningActivity = gameId;
            await this.updateActivity(this._activities[gameId]);

            if (this.connected && previousRunning && previousRunning.appId !== gameId) {
                toaster.toast({
                    title: 'Discord',
                    body: `Now playing ${this._activities[gameId].details.name}`
                });
            }
        } else {
            let wasCleared = false;
            if (gameId === this.runningActivity?.appId) {
                const cleared = await this.clearActivity();
                if (cleared) {
                    this.runningActivity = null;
                    wasCleared = true;
                }
            }

            if (this._activities[gameId]) {
                delete this._activities[gameId];
            }

            if (wasCleared) {
                // Let a new app pop up
                await new Promise((resolve) => setTimeout(resolve, 5000));

                const running = Router.MainRunningApp;
                if (running && this._activities[running.appid.toString()]) {
                    this._runningActivity = running.appid.toString();
                    await this.updateActivity(this._activities[this._runningActivity]);

                    if (this.connected) {
                        toaster.toast({
                            title: 'Discord',
                            body: `Now playing ${
                                this._activities[this._runningActivity].details.name
                            }`
                        });
                    }
                }
            }
        }
    }

    protected async onResume(progress: SuspendProgress) {
        if (progress.state !== ESuspendResumeProgressState.Complete) {
            return;
        }

        await sleep(2000);
        await this.checkConnection();

        const suspendTimeValue = localStorage.getItem(StorageKeys.SuspendTime);
        let suspendTime = 0;
        if (suspendTimeValue) {
            suspendTime = parseInt(suspendTimeValue, 10);
        }

        const activitiesValue = localStorage.getItem(StorageKeys.Activities);
        if (activitiesValue) {
            this._activities = JSON.parse(activitiesValue);
        }

        const runningActivityValue = localStorage.getItem(StorageKeys.RunningActivity);
        if (runningActivityValue) {
            this.runningActivity = JSON.parse(runningActivityValue);
        }

        Object.values(this.activities).forEach((activity) => {
            const previousPlaytime = suspendTime - activity.startTime;
            activity.startTime = Date.now() - previousPlaytime;
        });

        if (this.runningActivity) {
            await this.updateActivity(this.runningActivity);
        }

        log('Resuming', {
            activities: this.activities,
            runningActivity: this.runningActivity,
            suspendTime
        });

        localStorage.removeItem(StorageKeys.SuspendTime);
        localStorage.removeItem(StorageKeys.Activities);
        localStorage.removeItem(StorageKeys.RunningActivity);
    }

    protected async onSuspend(progress: SuspendProgress) {
        if (progress.state !== ESuspendResumeProgressState.Working) {
            return;
        }

        localStorage.setItem(StorageKeys.SuspendTime, Date.now().toString());
        localStorage.setItem(StorageKeys.Activities, JSON.stringify(this.activities));

        if (this.runningActivity) {
            localStorage.setItem(StorageKeys.RunningActivity, JSON.stringify(this.runningActivity));
            await this.clearActivity();
            log('Suspending with running activity', {
                suspendTime: Date.now().toString(),
                activities: this.activities,
                runningActivity: this.runningActivity
            });
        } else {
            log('Suspending', Date.now().toString(), JSON.stringify(this.activities));
        }

        if (this._connected) {
            await this.disconnect();
        }
    }
}
