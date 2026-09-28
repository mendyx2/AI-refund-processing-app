import {
  Armchair,
  CookingPot,
  Footprints,
  Gift,
  Glasses,
  Lamp,
  LoaderCircle,
  Mountain,
  NotebookPen,
  Package,
  RotateCcw,
  Shirt,
  Smartphone,
  type LucideIcon,
} from "lucide-react";

/** The store's brand mark + name. Fictional store for the demo. */
export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-500/30">
        <RotateCcw className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight text-slate-900">Shopwell</span>
        {subtitle && <span className="block text-xs text-slate-500">{subtitle}</span>}
      </span>
    </span>
  );
}

const CATEGORY: Record<string, { icon: LucideIcon; tint: string }> = {
  Electronics: { icon: Smartphone, tint: "bg-sky-50 text-sky-600 ring-sky-100" },
  Apparel: { icon: Shirt, tint: "bg-rose-50 text-rose-600 ring-rose-100" },
  Footwear: { icon: Footprints, tint: "bg-orange-50 text-orange-600 ring-orange-100" },
  "Home & Kitchen": { icon: CookingPot, tint: "bg-amber-50 text-amber-600 ring-amber-100" },
  Furniture: { icon: Armchair, tint: "bg-emerald-50 text-emerald-600 ring-emerald-100" },
  "Home Decor": { icon: Lamp, tint: "bg-yellow-50 text-yellow-600 ring-yellow-100" },
  Outdoors: { icon: Mountain, tint: "bg-teal-50 text-teal-600 ring-teal-100" },
  Accessories: { icon: Glasses, tint: "bg-fuchsia-50 text-fuchsia-600 ring-fuchsia-100" },
  "Gift Cards": { icon: Gift, tint: "bg-violet-50 text-violet-600 ring-violet-100" },
  Stationery: { icon: NotebookPen, tint: "bg-lime-50 text-lime-700 ring-lime-100" },
};

/** A tinted product thumbnail based on the order's category. */
export function CategoryIcon({ category, size = "md" }: { category: string; size?: "sm" | "md" }) {
  const { icon: Icon, tint } = CATEGORY[category] ?? {
    icon: Package,
    tint: "bg-slate-50 text-slate-600 ring-slate-100",
  };
  const box = size === "sm" ? "h-9 w-9 rounded-lg" : "h-12 w-12 rounded-xl";
  return (
    <span className={`grid shrink-0 place-items-center ring-1 ring-inset ${box} ${tint}`} aria-hidden>
      <Icon className={size === "sm" ? "h-4 w-4" : "h-5 w-5"} />
    </span>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <LoaderCircle className={`animate-spin ${className}`} aria-hidden />;
}
