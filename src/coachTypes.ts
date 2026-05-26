export type GithubMentorPageType =
  | 'campus'
  | 'github_code'
  | 'github_general'
  | 'codespace'
  | 'other';

export type MentorPageContext = 'campus' | 'github' | 'unknown';

export type LearningGoalId =
  | 'oop_basics'
  | 'encapsulation'
  | 'inheritance'
  | 'debugging'
  | 'github_flow';

export type GithubMentorContext = {
  url?: string;
  title?: string;
  pageContext?: MentorPageContext;
  pageType?: GithubMentorPageType;
  repoOwner?: string;
  repoName?: string;
  repoFullName?: string;
  branch?: string;
  filePath?: string;
  languageHint?: string;
  activityTitle?: string;
  learningGoal?: LearningGoalId;
  selection?: string;
  visibleError?: string;
  codeSnippet?: string;
  codeLineCount?: number;
};

export type GithubMentorResult = {
  ideas: string[];
  searches: string[];
  guide: string[];
  welcome_message: string;
  analysis_summary: string;
};

export type InterventionResponse =
  | {
      ok: true;
      source?: 'ai' | 'heuristic' | 'policy';
      result: GithubMentorResult;
      policy_applied?: unknown;
      telemetry_id?: string | null;
    }
  | {
      ok: false;
      error: string;
    };

export type CoachEvent =
  | 'manual'
  | 'idle_wait'
  | 'diagnostic_repeat'
  | 'task_failed';

export type StallSignal = {
  event: CoachEvent;
  waitMs: number;
  reason: string;
  diagnosticMessage?: string;
};

export type ProjectMemoryMetrics = {
  suggestionsReceived: number;
  suggestionsAccepted: number;
  errorsDetected: number;
  quizzesTaken: number;
};
