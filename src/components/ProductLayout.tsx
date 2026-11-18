import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import {
  Box,
  Boxes,
  ChevronDown,
  ClipboardCheck,
  CircuitBoard,
  FolderKanban,
  LogOut,
  Menu,
  PackageSearch,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "客户项目", icon: FolderKanban, end: true },
  { path: "/modules", label: "通用模块库", icon: Boxes },
  { path: "/components", label: "部件与来源", icon: PackageSearch },
  { path: "/twin", label: "设备仿真工作台", icon: CircuitBoard },
  { path: "/validation", label: "验证中心", icon: ClipboardCheck },
];

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-8 w-8 shrink-0 grid-cols-2 gap-[3px] rounded-[5px] border border-primary/30 bg-primary/10 p-[6px]">
        <span className="bg-primary" /><span className="border border-primary/60" />
        <span className="border border-primary/60" /><span className="bg-primary/45" />
      </div>
      <div>
        <div className="display-title text-[17px] font-semibold leading-none tracking-[-.02em]">构元</div>
        <div className="mono mt-1 text-[8px] uppercase tracking-[.18em] text-muted-foreground">Module engineering</div>
      </div>
    </div>
  );
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="mt-8 space-y-1">
      <div className="eyebrow mb-3 px-3">工作空间</div>
      {navItems.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) => cn(
            "group flex h-10 items-center gap-3 rounded-md border border-transparent px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
            isActive && "border-primary/15 bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
          )}
        >
          <item.icon className="h-[17px] w-[17px]" strokeWidth={1.6} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-full flex-col p-4">
      <div className="px-2 py-1"><Brand /></div>
      <Navigation onNavigate={onNavigate} />
      <div className="mt-auto space-y-3">
        <div className="rounded-md border border-primary/15 bg-primary/[.055] p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-primary"><Box className="h-3.5 w-3.5" />客户试点自动配置版</div>
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">工程初算与来源追溯已启用。制造验证与 Modelica 回归仍有明确边界。</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/60">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-medium text-foreground">{user?.name?.slice(0, 1) ?? "用"}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{user?.name ?? "当前用户"}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{user?.email ?? "已登录工作区"}</div>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive"><LogOut className="mr-2 h-4 w-4" />退出登录</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export default function ProductLayout({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth({ redirectOnUnauthenticated: true });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center"><div className="flex items-center gap-3 text-sm text-muted-foreground"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" />正在恢复工程工作区…</div></div>;
  }
  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] border-r bg-[#0c110f] lg:block"><SidebarContent /></aside>
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/95 px-4 backdrop-blur lg:hidden">
        <Brand />
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild><Button variant="outline" size="icon" aria-label="打开导航"><Menu className="h-5 w-5" /></Button></SheetTrigger>
          <SheetContent side="left" className="w-[290px] p-0"><SidebarContent onNavigate={() => setMobileOpen(false)} /></SheetContent>
        </Sheet>
      </header>
      <div className="lg:pl-[232px]">
        <div className="flex h-11 items-center justify-between border-b bg-card/45 px-4 text-[11px] text-muted-foreground sm:px-6">
          <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-primary" />工作区已连接 <span className="text-border">/</span><span className="mono">{location.pathname}</span></div>
          <div className="mono hidden sm:block">PILOT · 0.2.0</div>
        </div>
        <main className="min-h-[calc(100vh-44px)]">{children}</main>
      </div>
    </div>
  );
}
