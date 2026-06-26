import { ReactNode } from 'react';

const toneClasses = {
  blue: 'from-blue-500/20 to-blue-600/5 border-blue-500/30 text-blue-400',
  green: 'from-green-500/20 to-green-600/5 border-green-500/30 text-green-400',
  orange: 'from-orange-500/20 to-orange-600/5 border-orange-500/30 text-orange-400',
  red: 'from-red-500/20 to-red-600/5 border-red-500/30 text-red-400',
  purple: 'from-purple-500/20 to-purple-600/5 border-purple-500/30 text-purple-400',
};

export function MetricCard({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  detail: string;
  tone: keyof typeof toneClasses;
}) {
  return (
    <div className={`rounded-3xl border bg-gradient-to-br p-5 ${toneClasses[tone]}`}>
      <div className="mb-4">{icon}</div>
      <p className="text-sm font-medium text-stone-400">{label}</p>
      <p className="mt-2 text-3xl font-bold text-white">{value}</p>
      <p className="mt-1 text-xs text-stone-500">{detail}</p>
    </div>
  );
}

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-stone-700/50 bg-stone-900/60 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-6">
      {eyebrow && <p className="text-xs font-semibold uppercase tracking-widest text-orange-400">{eyebrow}</p>}
      <h2 className="text-2xl font-bold text-white">{title}</h2>
      {description && <p className="mt-1 text-sm text-stone-400">{description}</p>}
    </div>
  );
}

export function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: (string | ReactNode)[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-stone-700 text-left text-stone-400">
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length} className="px-3 py-8 text-center text-stone-500">
                No records
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} className="border-b border-stone-800/80 text-stone-200">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-3">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function StatusPill({ label, tone }: { label: string; tone: 'green' | 'orange' | 'red' | 'gray' | 'blue' }) {
  const colors = {
    green: 'bg-green-500/20 text-green-400',
    orange: 'bg-orange-500/20 text-orange-300',
    red: 'bg-red-500/20 text-red-400',
    gray: 'bg-stone-500/20 text-stone-400',
    blue: 'bg-blue-500/20 text-blue-400',
  };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[tone]}`}>{label}</span>;
}
