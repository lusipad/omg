import type { ReactNode } from "react";

export default function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <div className="eyebrow mb-2">{eyebrow}</div>
        <h1 className="display-title text-[27px] font-medium leading-tight text-foreground sm:text-[31px]">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-[13px] leading-6 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
