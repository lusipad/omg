import type { PrimitiveFinish, PrimitivePartSpec } from "@contracts/primitive-parts";

export interface SandboxBlockIconProps {
  shape: PrimitivePartSpec["shape"] | "custom";
  finish?: PrimitiveFinish;
  blockId?: string;
  className?: string;
}

const FINISH_COLOR: Record<PrimitiveFinish, string> = {
  aluminum: "#cbd5e1",
  anodized_black: "#64748b",
  steel: "#94a3b8",
  brass: "#eab308",
  spindle_red: "#f87171",
  workpiece_alloy: "#a5b4fc",
  sensor_amber: "#fbbf24",
  rubber_grip: "#38bdf8",
  aerospace_white: "#f8fafc",
  pearl_crimson: "#f472b6",
};

export function SandboxBlockIcon({
  shape,
  finish,
  blockId,
  className = "size-8 shrink-0",
}: SandboxBlockIconProps) {
  const accent = finish ? FINISH_COLOR[finish] : "#5eead4";

  // Dedicated icons for cross-domain universal blocks
  if (blockId === "drive_wheel" || (shape === "cylinder" && finish === "rubber_grip")) {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <circle cx="18" cy="18" r="12" fill="#0f172a" stroke="#38bdf8" strokeWidth="3.2" strokeDasharray="4 2.2" />
        <circle cx="18" cy="18" r="6" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.6" />
        <circle cx="18" cy="18" r="2.2" fill="#5eead4" />
      </svg>
    );
  }

  if (blockId === "passive_hinge") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <circle cx="18" cy="18" r="9.5" fill="#422006" stroke="#eab308" strokeWidth="2" />
        <circle cx="18" cy="18" r="3.5" fill="#0f172a" stroke="#fde047" strokeWidth="1.5" />
        <path d="M9 11a12 12 0 0 1 18 0" stroke="#5eead4" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="2.5 2" />
      </svg>
    );
  }

  if (blockId === "link_rod") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <rect x="4" y="13" width="28" height="10" rx="5" fill="#1e293b" stroke="#cbd5e1" strokeWidth="1.8" />
        <circle cx="9.5" cy="18" r="2.5" fill="#0f172a" stroke="#5eead4" strokeWidth="1.6" />
        <circle cx="26.5" cy="18" r="2.5" fill="#0f172a" stroke="#5eead4" strokeWidth="1.6" />
      </svg>
    );
  }

  if (blockId === "rocket_thruster") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <path d="M14 6h8l4 13H10l4-13Z" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M13 19l2 10 3-5 3 5 2-10" fill="#fb923c" fillOpacity="0.45" stroke="#f97316" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }

  if (blockId === "rotor_propeller") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <line x1="4" y1="16" x2="32" y2="16" stroke="#38bdf8" strokeWidth="3.2" strokeLinecap="round" />
        <circle cx="18" cy="16" r="4" fill="#0f172a" stroke="#e2e8f0" strokeWidth="1.6" />
        <path d="M12 24h12M18 20v7" stroke="#5eead4" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (shape === "sphere") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <circle cx="18" cy="18" r="11.5" fill={finish === "pearl_crimson" ? "#831843" : "#1e293b"} stroke={accent} strokeWidth="1.8" />
        <ellipse cx="18" cy="18" rx="11.5" ry="4" stroke="#f8fafc" strokeWidth="1.2" strokeOpacity="0.7" />
      </svg>
    );
  }

  if (shape === "cone") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <path d="M18 5 28 29H8L18 5Z" fill="#1e293b" stroke={accent} strokeWidth="1.8" strokeLinejoin="round" />
        <ellipse cx="18" cy="29" rx="10" ry="2.5" stroke={accent} strokeWidth="1.2" />
      </svg>
    );
  }

  if (blockId === "gripper_finger") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <rect x="7" y="7" width="22" height="6" rx="2" fill="#334155" stroke="#94a3b8" strokeWidth="1.5" />
        <path d="M12 13v13l3 3M24 13v13l-3 3" stroke="#38bdf8" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="14" y="21" width="8" height="7" rx="1.2" fill="#f59e0b" fillOpacity="0.35" stroke="#fbbf24" strokeWidth="1.3" />
      </svg>
    );
  }

  // Distinction among "box" shapes based on blockId or finish
  if (blockId === "limit_switch" || finish === "sensor_amber") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <rect x="6" y="10" width="20" height="16" rx="3" fill="#451a03" stroke="#f59e0b" strokeWidth="1.8" />
        <circle cx="23" cy="14" r="2.5" fill="#fbbf24" />
        <path d="M26 18h5M6 21H2" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" />
        <path d="M12 15v6M16 15v6" stroke="#fde68a" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (blockId === "rotary_y" || finish === "brass") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <rect x="8" y="11" width="20" height="14" rx="3" fill="#422006" stroke="#eab308" strokeWidth="1.8" />
        <circle cx="18" cy="18" r="4" fill="#eab308" />
        <path d="M10 8a11 11 0 0 1 16 0" stroke="#fde047" strokeWidth="1.8" strokeLinecap="round" />
        <path d="m24 5 2 3-3.5.5" stroke="#fde047" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (blockId === "gripper_tip" || (shape === "box" && finish === "spindle_red")) {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <rect x="10" y="6" width="16" height="10" rx="2.5" fill="#450a0a" stroke="#f87171" strokeWidth="1.8" />
        <path d="M13 16v9l3 4M23 16v9l-3 4" stroke="#fca5a5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="18" cy="29" r="2" fill="#f97316" />
      </svg>
    );
  }

  if (blockId === "workpiece_block" || finish === "workpiece_alloy") {
    return (
      <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
        <polygon points="18,6 30,12 18,18 6,12" fill="#312e81" stroke="#a5b4fc" strokeWidth="1.6" />
        <polygon points="6,12 18,18 18,29 6,23" fill="#1e1b4b" stroke="#818cf8" strokeWidth="1.6" />
        <polygon points="30,12 18,18 18,29 30,23" fill="#272462" stroke="#818cf8" strokeWidth="1.6" />
      </svg>
    );
  }

  switch (shape) {
    case "extrusion_profile":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <rect x="5" y="10" width="26" height="16" rx="2" fill="#1e293b" stroke="#94a3b8" strokeWidth="1.8" />
          <line x1="5" y1="15" x2="31" y2="15" stroke="#38bdf8" strokeWidth="1.3" strokeOpacity="0.8" />
          <line x1="5" y1="21" x2="31" y2="21" stroke="#38bdf8" strokeWidth="1.3" strokeOpacity="0.8" />
          <circle cx="9.5" cy="18" r="1.5" fill="#cbd5e1" />
          <circle cx="26.5" cy="18" r="1.5" fill="#cbd5e1" />
        </svg>
      );
    case "plate":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <rect x="5" y="9" width="26" height="18" rx="3" fill="#1e293b" stroke="#cbd5e1" strokeWidth="1.8" />
          <circle cx="10" cy="14" r="1.7" fill="#5eead4" />
          <circle cx="26" cy="14" r="1.7" fill="#5eead4" />
          <circle cx="10" cy="22" r="1.7" fill="#5eead4" />
          <circle cx="26" cy="22" r="1.7" fill="#5eead4" />
          <rect x="13" y="15" width="10" height="6" rx="1" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
      );
    case "angle_bracket":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <path d="M8 7h7v14h13v7H8V7Z" fill="#334155" stroke="#cbd5e1" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M15 11l9 10" stroke="#5eead4" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "linear_rail_block":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <rect x="4" y="21" width="28" height="6" rx="1.5" fill="#334155" stroke="#94a3b8" strokeWidth="1.6" />
          <rect x="11" y="11" width="14" height="11" rx="2" fill="#0f766e" stroke="#2dd4bf" strokeWidth="1.8" />
          <path d="M8 7h20m-20 0 3-2.5M8 7l3 2.5M28 7l-3-2.5M28 7l-3 2.5" stroke="#5eead4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "cylinder":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <ellipse cx="18" cy="13" rx="11" ry="5" fill="#1e293b" stroke="#38bdf8" strokeWidth="1.8" />
          <path d="M7 13v9c0 2.8 4.9 5 11 5s11-2.2 11-5v-9" fill="#0f172a" stroke="#38bdf8" strokeWidth="1.8" />
          <path d="M10 6a12 6 0 0 1 16 0" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" />
          <path d="m24.5 3.8 2 2.5-3 .6" stroke="#2dd4bf" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "lead_screw":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <rect x="4" y="15" width="28" height="6" rx="2" fill="#334155" stroke="#cbd5e1" strokeWidth="1.5" />
          <path d="M9 15l3 6M15 15l3 6M21 15l3 6M27 15l3 6" stroke="#38bdf8" strokeWidth="1.6" strokeLinecap="round" />
          <rect x="13" y="11" width="10" height="14" rx="2" fill="#0d9488" fillOpacity="0.4" stroke="#5eead4" strokeWidth="1.6" />
        </svg>
      );
    case "servo_motor_body":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <rect x="6" y="10" width="17" height="16" rx="2" fill="#1e293b" stroke="#60a5fa" strokeWidth="1.8" />
          <rect x="23" y="15" width="8" height="6" rx="1" fill="#94a3b8" stroke="#e2e8f0" strokeWidth="1.4" />
          <path d="M11 18h7M14.5 14.5v7" stroke="#60a5fa" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "spindle_cutter":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <rect x="11" y="5" width="14" height="15" rx="2.5" fill="#450a0a" stroke="#f87171" strokeWidth="1.8" />
          <rect x="14" y="20" width="8" height="4" fill="#64748b" />
          <path d="M16 24v7l2 2 2-2v-7" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.3" />
          <circle cx="18" cy="12" r="2.2" fill="#fca5a5" />
        </svg>
      );
    case "tube":
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <rect x="12" y="5" width="12" height="26" rx="4" fill="#1e293b" stroke="#cbd5e1" strokeWidth="1.8" />
          <ellipse cx="18" cy="8.5" rx="4.5" ry="2.2" fill="#0f172a" stroke="#5eead4" strokeWidth="1.4" />
          <circle cx="18" cy="25" r="2" fill="#5eead4" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
          <rect x="8" y="8" width="20" height="20" rx="3" fill="#1e293b" stroke={accent} strokeWidth="1.8" />
          <circle cx="18" cy="18" r="4" stroke={accent} strokeWidth="1.6" />
        </svg>
      );
  }
}
