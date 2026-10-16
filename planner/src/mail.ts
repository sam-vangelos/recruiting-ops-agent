/**
 * Gmail replies in the candidate's existing thread (WORKFLOW.md: "A new thread is a defect"). This is a
 * plain object; the spike's `mime.ts` turns it into RFC 2822 when dispatch is wired.
 */
import type { Candidate } from './types.js';

export interface Reply {
  to: string[];
  subject: string;
  threadId: string;
  inReplyTo: string;
  references: string;
  body: string;
}

/** `subjectRule` is the template's channel; only `gmail-reply` ("Re: <thread subject>") exists. */
export function buildReply(candidate: Candidate, subjectRule: 'gmail-reply', body: string): Reply {
  if (subjectRule !== 'gmail-reply') throw new Error(`no subject rule for channel ${String(subjectRule)}`);
  if (candidate.threadId.trim() === '') throw new Error('a reply needs the candidate thread id; a new thread is a defect');
  if (!/^<[^<>\s]+>$/.test(candidate.lastMessageId)) {
    throw new Error(`lastMessageId must be the RFC 2822 Message-ID header, e.g. <abc@mail.gmail.com>; got ${JSON.stringify(candidate.lastMessageId)}`);
  }
  const subject = /^re:/i.test(candidate.threadSubject) ? candidate.threadSubject : `Re: ${candidate.threadSubject}`;
  return {
    to: [candidate.email],
    subject,
    threadId: candidate.threadId,
    inReplyTo: candidate.lastMessageId,
    references: candidate.lastMessageId,
    body,
  };
}
