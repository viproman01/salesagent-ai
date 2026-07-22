import { cn } from '../ui/cn';

export interface Chip { key: string; label: string }

interface Props {
  chips: Chip[];
  value: string | null;
  onChange: (v: string | null) => void;
}

export default function ChipFilterRow({ chips, value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1.5 px-2 border-b border-line">
      <button
        onClick={() => onChange(null)}
        className={cn(
          'h-7 px-2.5 text-[12px] rounded-full border transition-colors whitespace-nowrap',
          value === null ? 'bg-bg-2 text-fg-0 border-fg-2/30' : 'border-transparent text-fg-2 hover:text-fg-0'
        )}
      >Все</button>
      {chips.map(c => (
        <button
          key={c.key}
          onClick={() => onChange(c.key)}
          className={cn(
            'h-7 px-2.5 text-[12px] rounded-full border whitespace-nowrap transition-colors',
            value === c.key ? 'bg-bg-2 text-fg-0 border-fg-2/30' : 'border-transparent text-fg-2 hover:text-fg-0'
          )}
        >{c.label}</button>
      ))}
    </div>
  );
}
