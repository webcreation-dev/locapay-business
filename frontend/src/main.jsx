import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import FacebookGroups from './FacebookGroups.jsx'
import './index.css'

const path = window.location.pathname;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {path === '/list_facebook' ? <FacebookGroups /> : <App />}
  </React.StrictMode>,
)
