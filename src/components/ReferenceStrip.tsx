import { ChevronRight } from 'lucide-react';
import type { ReferenceItem } from '../lib/types';
import { referencePublication, referenceSubtitle, referenceSummary } from '../lib/reference-presentation';
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
      const subtitle = reference.parse_confidence === 'parsed' ? referenceSubtitle(reference, true)
        : reference.arxiv_id ? referencePublication(reference) : '';
      return <li key={reference.reference_id}>
        <button type="button" aria-label={`Reference ${reference.label ? `${reference.label}: ` : ''}${summary}`}
          title={subtitle || undefined} onClick={() => on_select(reference)}>
          <span className="reference-strip-label">{reference.label ?? 'Ref'}</span>
          <span className="reference-strip-content">
            <span className="reference-strip-title">{summary}</span>
            {subtitle && <span className="reference-strip-publication">{subtitle}</span>}
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </li>;
    })}</ul>
  </aside>;
}
