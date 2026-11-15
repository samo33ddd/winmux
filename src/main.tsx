import { createRoot } from 'react-dom/client';
import App from './App';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './tools.css';
import './settings.css';
import './navigation.css';

createRoot(document.getElementById('root')!).render(<App />);
