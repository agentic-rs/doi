import { ChevronRight } from 'lucide-react';
import type { ReferenceItem } from '../lib/types';
import { referenceSummary } from './ReferenceCard';
import './reference-components.css';

export interface ReferenceStripProps {
  references: ReferenceItem[];
  on_select: (reference: ReferenceItem) => void;
}

export function ReferenceStrip({ references, on_select }: ReferenceStripProps) {
  if (references.length === 0) return null;
  return <aside className="reference-strip" aria-label="References for this passage">
    <ul>{references.map((reference) => {
      const summary = referenceSummary(reference);
      const publication = reference.parse_confidence === 'parsed'
        ? [reference.authors?.[0], reference.publication_year].filter(Boolean).join(' · ') : '';
      return <li key={reference.reference_id}>
        <button type="button" aria-label={`Reference ${reference.label ? `${reference.label}: ` : ''}${summary}`}
          onClick={() => on_select(reference)}>
          <span className="reference-strip-label">{reference.label ?? 'Ref'}</span>
          <span className="reference-strip-content">
            <span className="reference-strip-title">{summary}</span>
            {publication && <span className="reference-strip-publication">{publication}</span>}
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </li>;
    })}</ul>
  </aside>;
}
