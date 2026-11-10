import '@xyflow/react/dist/style.css';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { registerSW } from './pwa.ts';
import { applyTheme } from './theme.ts';
import { connect } from './store.ts';
import './styles.css';

applyTheme();
registerSW();
connect();
createRoot(document.getElementById('root')!).render(<App />);
