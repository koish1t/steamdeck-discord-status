import { FC, Fragment, useCallback, useContext, useMemo, useState } from 'react';
import { ButtonItem, DropdownItem, Field, PanelSection, PanelSectionRow, Spinner, TextField } from '@decky/ui';
import { Actions, ConnectionStatus, Context } from './context';
import { FaCheck, FaEye, FaEyeSlash } from 'react-icons/fa';

const QuickAccessPanel: FC<{}> = () => {
    const [state, dispatch] = useContext(Context);
    const [tokenInput, setTokenInput] = useState(state.token);
    const [showToken, setShowToken] = useState(false);

    const onSaveToken = useCallback(async () => {
        dispatch(Actions.setToken(tokenInput));
        dispatch(Actions.connect());
    }, [dispatch, tokenInput]);

    const onReconnect = useCallback(async () => {
        dispatch(Actions.connect());
    }, [dispatch]);

    const options = useMemo(
        () => [
            ...state.runningApps.map((app) => ({
                label: <Fragment>{app.details.name}</Fragment>,
                data: app
            })),
            {
                label: '<None>',
                data: null
            }
        ],
        [state]
    );

    return (
        <PanelSection>
            <PanelSectionRow>
                <Field label="Discord Token" description="Your Discord user token for authentication">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <TextField
                            value={tokenInput}
                            onChange={(e) => setTokenInput(e.target.value)}
                            bIsPassword={!showToken}
                            style={{ flex: 1 }}
                        />
                        <div
                            onClick={() => setShowToken(!showToken)}
                            style={{ cursor: 'pointer', padding: '8px' }}
                        >
                            {showToken ? <FaEyeSlash /> : <FaEye />}
                        </div>
                    </div>
                </Field>
            </PanelSectionRow>
            <PanelSectionRow>
                <ButtonItem layout="below" onClick={onSaveToken}>
                    Save Token & Connect
                </ButtonItem>
            </PanelSectionRow>

            <PanelSectionRow>
                {state.connectionStatus === ConnectionStatus.CONNECTING && (
                    <Fragment>
                        <Field childrenLayout="inline" label="Connecting...">
                            <Spinner />
                        </Field>
                    </Fragment>
                )}
                {state.connectionStatus === ConnectionStatus.DISCONNECTED && state.token && (
                    <Fragment>
                        <ButtonItem layout="below" onClick={onReconnect}>
                            Reconnect
                        </ButtonItem>
                        <div style={{ padding: '4px 0px', color: '#dcdedf' }}>
                            Not connected to Discord.
                        </div>
                    </Fragment>
                )}
                {state.connectionStatus === ConnectionStatus.DISCONNECTED && !state.token && (
                    <div style={{ padding: '4px 0px', color: '#dcdedf' }}>
                        Enter your Discord token above to connect.
                    </div>
                )}
                {state.connectionStatus === ConnectionStatus.CONNECTED && (
                    <Fragment>
                        <Field label={`Connected as ${state.user?.global_name || state.user?.username || 'Unknown'}`}>
                            <FaCheck />
                        </Field>
                    </Fragment>
                )}
            </PanelSectionRow>
            {state.connectionStatus === ConnectionStatus.CONNECTED && (
                <Fragment>
                    {state.currentApp && (
                        <PanelSectionRow>
                            <Field
                                bottomSeparator="none"
                                icon={null}
                                label={null}
                                childrenLayout={undefined}
                                inlineWrap={undefined}
                                padding="none"
                                spacingBetweenLabelAndChild="none"
                                childrenContainerWidth="max"
                            >
                                <div style={{ display: 'flex', width: '100%' }}>
                                    <div style={{ flex: '0 0 48px' }}>
                                        <img
                                            src={state.currentApp.localImageUrl}
                                            style={{ width: '48px' }}
                                        />
                                    </div>
                                    <div
                                        style={{
                                            color: '#dcdedf',
                                            fontSize: '1.2em',
                                            flex: '1 1 auto',
                                            marginLeft: '10px',
                                            width: '100%'
                                        }}
                                    >
                                        {state.currentApp.details.name}
                                    </div>
                                </div>
                            </Field>
                        </PanelSectionRow>
                    )}
                    {state.runningApps.length > 0 && (
                        <PanelSectionRow>
                            <DropdownItem
                                label="Set Reported App"
                                description="Change the game or application that is reported to Discord."
                                rgOptions={options}
                                onChange={(option) => {
                                    if (option && option.data) {
                                        dispatch(Actions.changeRunningApp(option.data));
                                    } else if (option && !option.data) {
                                        dispatch(Actions.changeRunningApp(null));
                                    }
                                }}
                                selectedOption={
                                    state.currentApp
                                        ? state.runningApps.find(
                                              (a) => a.appId === state.currentApp?.appId
                                          )
                                        : null
                                }
                            />
                        </PanelSectionRow>
                    )}
                </Fragment>
            )}
        </PanelSection>
    );
};

export default QuickAccessPanel;
