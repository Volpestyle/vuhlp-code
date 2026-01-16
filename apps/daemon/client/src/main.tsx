import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
// Import vuhlp ui styles (both packages loaded, scoped by data-ui-package attribute)
import '@vuhlp/ui/styles'
import '@vuhlp/ui-refresh/styles'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
