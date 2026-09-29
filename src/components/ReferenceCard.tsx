import { ArrowUpRight, BookOpen, FileText, LoaderCircle, Search } from 'lucide-react';
import type { ReferenceCandidate, ReferenceItem } from '../lib/types';
import './reference-components.css';

export interface ReferenceResolution {
  busy: boolean;
  candidates: ReferenceCandidate[];
  error: string | null;
}

export interface ReferenceCardProps {
  reference: ReferenceItem;
  resolution?: ReferenceResolution;
  busy: boolean;
  on_open: (reference: ReferenceItem | ReferenceCandidate) => void;
  on_find: (reference: ReferenceItem) => void;
  on_source: (reference: ReferenceItem) => void;
}

export function referenceSummary(reference: ReferenceItem): string {
  return reference.parse_confidence === 'parsed' && reference.title?.trim()
    ? reference.title : reference.citation_text;
}

function CandidateDetails({ candidate }: { candidate: ReferenceCandidate }) {
  const publication = [candidate.publication_year, candidate.venue].filter(Boolean).join(' · ');
  return <span className="reference-entry-candidate-content">
    <span className="reference-entry-match-kind">{candidate.match_kind === 'identifier' ? 'Identifier match' : 'Possible match'}</span>
    <strong>{candidate.title}</strong>
    {candidate.authors?.length > 0 && <span>{candidate.authors.join(', ')}</span>}
    {publication && <span>{publication}</span>}
  </span>;
}

export function ReferenceCard(props: ReferenceCardProps) {
  const { reference, resolution } = props;
  const parsed = reference.parse_confidence === 'parsed' && Boolean(reference.title?.trim());
  const publication = [reference.publication_year, reference.venue].filter(Boolean).join(' · ');
  const can_open = Boolean(reference.arxiv_id || reference.doi || reference.url);
  const candidates = resolution?.candidates ?? [];
  const finding = Boolean(resolution?.busy);
  const disabled = props.busy || finding;
  const open_label = reference.arxiv_id ? 'Preview paper' : reference.doi ? 'Open DOI' : 'Open link';

  return <article className="reference-entry" aria-label={reference.label ? `Reference ${reference.label}` : 'Reference'}>
    <header className="reference-entry-heading">
      <span className="reference-entry-label">{reference.label ?? 'Reference'}</span>
      <span>Bibliography · p. {reference.page_number}</span>
    </header>
    {parsed ? <div className="reference-entry-metadata">
      <h3>{reference.title}</h3>
      {reference.authors.length > 0 && <p className="reference-entry-authors">{reference.authors.join(', ')}</p>}
      {publication && <p className="reference-entry-publication">{publication}</p>}
      <details className="reference-entry-original">
        <summary tabIndex={0}>Original citation</summary>
        <p>{reference.citation_text}</p>
      </details>
    </div> : <p className="reference-entry-citation">{reference.citation_text}</p>}
    {reference.arxiv_id && <p className="reference-entry-identifier">arXiv:{reference.arxiv_id}</p>}
    {reference.doi && <p className="reference-entry-identifier">DOI: {reference.doi}</p>}
    <div className="reference-entry-actions">
      {can_open && <button type="button" className="reference-entry-open" disabled={disabled} onClick={() => props.on_open(reference)}>
        {reference.arxiv_id ? <BookOpen size={16} aria-hidden="true" /> : <ArrowUpRight size={16} aria-hidden="true" />}{open_label}
      </button>}
      {reference.arxiv_id && reference.doi && <button type="button" disabled={disabled}
        onClick={() => props.on_open({ ...reference, arxiv_id: null })}>
        <ArrowUpRight size={16} aria-hidden="true" />Open DOI
      </button>}
      {!reference.arxiv_id && candidates.length === 0 && <button type="button" disabled={disabled} onClick={() => props.on_find(reference)}>
        {finding ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
        {finding ? 'Finding matches…' : 'Find a match'}
      </button>}
      {reference.page_number > 0 && <button type="button" className="reference-entry-source" disabled={disabled}
        aria-label={`View bibliography on page ${reference.page_number}`} onClick={() => props.on_source(reference)}>
        <FileText size={16} aria-hidden="true" />View bibliography
      </button>}
    </div>
    {resolution && <div className="reference-entry-results">
      {finding ? <p role="status">Looking for matching references…</p>
        : resolution.error ? <p className="reference-entry-error" role="alert">{resolution.error}</p>
          : candidates.length > 0 ? <>
            <p className="reference-entry-results-label">Choose a match</p>
            <ul>{candidates.map((candidate, index) => <li key={`${candidate.arxiv_id ?? candidate.doi ?? candidate.url}-${index}`}>
              <button type="button" className="reference-entry-candidate" disabled={props.busy}
                aria-label={`Open ${candidate.match_kind === 'identifier' ? 'identifier match' : 'possible match'}: ${candidate.title}`}
                onClick={() => props.on_open(candidate)}>
                <CandidateDetails candidate={candidate} /><ArrowUpRight size={16} aria-hidden="true" />
              </button>
            </li>)}</ul>
          </> : <p role="status">No matches found.</p>}
    </div>}
  </article>;
}
