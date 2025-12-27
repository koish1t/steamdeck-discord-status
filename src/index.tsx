import { Api } from './api';
import { definePlugin } from '@decky/api';
import { FaDiscord } from 'react-icons/fa';
import { Provider } from './context';
import { staticClasses } from '@decky/ui';
import QuickAccessPanel from './QuickAccessPanel';

export default definePlugin(() => {
    const api = Api.initialize();

    return {
        name: 'Discord Status',
        titleView: <div className={staticClasses.Title}>Discord Status</div>,
        content: (
            <Provider api={api}>
                <QuickAccessPanel />
            </Provider>
        ),
        icon: <FaDiscord />,
        onDismount: () => {
            api.unregister();
        }
    };
});
