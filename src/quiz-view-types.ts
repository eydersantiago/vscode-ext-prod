// ADACEEN (VS Code): tipos, constantes y utilidades de la vista «Quiz y seguimiento».
// Movido sin cambios desde src/quiz-view.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';

export type QuizRequestContext = {
  baseUrl: string;
  headers: Record<string, string>;
};

export type QuizHistoryItem = {
  id: string;
  fileName: string;
  meta: string;
  summary: string;
};

export type QuizAcceptedChange = {
  filePath: string;
  language: string;
  applyMode: 'insert' | 'replace' | 'delete';
  originalCode: string;
  newCode: string;
  suggestionText: string;
  ragCourseCode: string;
  repoFullName: string;
};

export type PublicQuiz = {
  id: string;
  trigger: 'after_accept' | 'teacher_launch';
  launchId: string | null;
  status: 'pending' | 'followup' | 'done' | 'skipped' | 'expired';
  topic: string;
  filePath: string;
  language: string;
  question: string;
  options: string[];
  createdAt: string;
  result: { correct: boolean; chosenIndex: number; correctIndex: number; explanation: string } | null;
  followUpQuestion: string | null;
  followUp: { answer: string; score: number | null; feedback: string } | null;
};

type ViewPhase = 'idle' | 'loading' | 'quiz' | 'error';

export type ViewState = {
  phase: ViewPhase;
  message: string;
  quiz: PublicQuiz | null;
  busy: boolean;
  history: QuizHistoryItem[];
};

export type QuizViewOptions = {
  memento: vscode.Memento;
  output: vscode.OutputChannel;
  getRequestContext: () => QuizRequestContext | null;
  openHistoryEntry: (id: string) => void;
  openAllHistory: () => void;
  /** El backend respondio x-adaceen-session: invalid a esta sesion (src/editor-session.ts). */
  onSessionInvalid?: (sessionId: string) => void;
};

export const ACCEPT_COUNT_KEY = 'adaceen.quiz.acceptCount';
export const PENDING_POLL_MS = 30000;
export const GENERATE_TIMEOUT_MS = 150000;
export const DEFAULT_TIMEOUT_MS = 60000;

export function randomId(length: number) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
