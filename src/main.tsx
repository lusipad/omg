import "@/lib/logger";
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import { TRPCProvider } from "@/providers/trpc"
import { Toaster } from "sonner"
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <TRPCProvider>
        <App />
        <Toaster theme="dark" position="bottom-right" richColors />
      </TRPCProvider>
    </BrowserRouter>
  </StrictMode>,
)
