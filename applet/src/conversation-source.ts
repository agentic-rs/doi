import { pageAnchorsKey, validateAnnotationTarget } from '../../src/lib/annotations';
import type { AiConversation, AiConversationRequest, AiConversationTurn, AiPassage, AnnotationTarget, Paper } from '../../src/lib/types';

export function sourceTarget(source: AiPassage): AnnotationTarget {
  const { paper_id, pdf_hash, page_anchors } = source;
  return page_anchors.length ? { paper_id, pdf_hash, page_anchors } : { paper_id, pdf_hash, page_anchors, scope: 'paper' };
}

export function turnPassages(paper: Paper, request: AiConversationRequest): AiPassage[] {
  const passages: AiPassage[] = [];
  const candidates = request.source ? [request.source, ...(request.attachments ?? [])] : request.attachments ?? [];
  for (const source of candidates) {
    validateAnnotationTarget(sourceTarget(source), paper);
    if (!source.page_anchors.length) {
      if (source !== request.source || source.selected_text || source.context_text) throw new Error('A passage attachment requires a selection.');
      continue;
    }
    if (!source.selected_text.trim() || source.selected_text.includes('\0') || source.context_text.includes('\0') ||
        new TextEncoder().encode(source.selected_text).byteLength > 32 * 1024 ||
        new TextEncoder().encode(source.context_text).byteLength > 128 * 1024) throw new Error('The attached passage is empty or too long.');
    const key = pageAnchorsKey(source.page_anchors);
    if (!passages.some(p => pageAnchorsKey(p.page_anchors) === key)) passages.push(source);
  }
  if (passages.length > 8) throw new Error('Attach up to eight passages to a question.');
  return passages;
}

function passageText(passage: AiPassage): string {
  const pages = passage.page_anchors.map(a => a.page_number).join(', ');
  return `Attached passage (p. ${pages}):\n${passage.selected_text}\nNearby text:\n${passage.context_text}`;
}

function legacyPassage(conversation: AiConversation): AiPassage[] {
  return conversation.selected_text ? [{ ...conversation.target, selected_text: conversation.selected_text, context_text: conversation.context_text }] : [];
}

export function sourceFor(paper: Paper, conversation: AiConversation, attachments = legacyPassage(conversation)): string {
  return [`Paper: ${paper.title}\narXiv revision: ${paper.paper_id}\nAuthors: ${paper.authors.join(', ')}\nAbstract: ${paper.abstract}`,
    ...attachments.map(passageText)].join('\n\n');
}

/** Source IDs are local to a turn. Replay the original quote in history to avoid
 * resolving a previous answer's [S1] against a different question's evidence. */
export function completedHistory(conversation: AiConversation): [string, string][] {
  return conversation.turns.filter(t => t.phase === 'complete').map((turn, index) => {
    const passages = turn.attachments ?? (index === 0 ? legacyPassage(conversation) : []);
    const question = [turn.question, ...passages.map(p => p.selected_text)].join('\n\n');
    const citations = new Map((turn.citations ?? []).map(c => [c.citation_id, c.anchor]));
    const answer = turn.answer.replace(/\[(S\d+)\]/g, (_, id) => {
      const anchor = citations.get(id);
      return anchor ? `(p. ${anchor.page_number})` : '(unverified source)';
    });
    const quotes = [...citations.values()].map(a => `p. ${a.page_number}: “${a.text_quote.exact_text}”`);
    return [question, [answer, ...quotes].join('\n\n')];
  });
}

export function validateNotePlacement(target: AnnotationTarget, conversation: AiConversation, turn: AiConversationTurn) {
  validateAnnotationTarget(target, conversation.target);
  if (target.scope === 'paper') return;
  const choices = [conversation.target.page_anchors, ...(turn.attachments ?? []).map(p => p.page_anchors),
    ...(turn.citations ?? []).map(c => [c.anchor])];
  const key = pageAnchorsKey(target.page_anchors);
  if (!choices.some(anchors => pageAnchorsKey(anchors) === key)) {
    throw new Error('Choose a passage from this question or one of its citations.');
  }
}
