import './styles.css';
import { mountApp } from './ui/app.ts';

const host = document.querySelector<HTMLElement>('#app');
if (!host) throw new Error('找不到 #app');
void mountApp(host);
