import { Routes, Route } from 'react-router'
import { lazy, Suspense } from "react";
import Home from './pages/Home'
import ComponentLibrary from "./pages/ComponentLibrary"
import Login from "./pages/Login"
import ModuleLibrary from "./pages/ModuleLibrary"
import NotFound from "./pages/NotFound"
import ProjectWorkbench from "./pages/ProjectWorkbench"
import ValidationCenter from "./pages/ValidationCenter"

const TwinStudio = lazy(() => import("./pages/TwinStudio"));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/projects/:projectId" element={<ProjectWorkbench />} />
      <Route path="/modules" element={<ModuleLibrary />} />
      <Route path="/components" element={<ComponentLibrary />} />
      <Route path="/twin" element={<Suspense fallback={<main className="p-6 text-muted-foreground">正在打开设备仿真工作台…</main>}><TwinStudio /></Suspense>} />
      <Route path="/validation" element={<ValidationCenter />} />
      <Route path="/login" element={<Login />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
