import { useState, type DragEvent } from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '../ui/cn';

interface Props {
  onFiles: (files: File[]) => void;
  accept?: string;
  hint?: string;
}

export default function UploadDropzone({ onFiles, accept, hint = 'PDF, CSV, TXT, MD — до 50 МБ' }: Props) {
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(files);
  };

  return (
    <label
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-3 py-8 px-6 cursor-pointer transition-colors',
        over ? 'border-accent bg-accent/5' : 'border-line bg-bg-1 hover:border-fg-2/30'
      )}
    >
      <UploadCloud size={22} className="text-fg-2" />
      <div className="text-[13px] text-fg-1">Перетащи файл сюда или <span className="text-accent">выбери</span></div>
      <div className="text-[11px] text-fg-2">{hint}</div>
      <input
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={e => e.target.files && onFiles(Array.from(e.target.files))}
      />
    </label>
  );
}
