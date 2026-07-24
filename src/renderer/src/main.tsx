import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// 不用 StrictMode：dev 下 effect 双跑会导致 pty spawn+kill 两次
createRoot(document.getElementById('root')!).render(<App />)
