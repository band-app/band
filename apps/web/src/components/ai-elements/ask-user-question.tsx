import { Button, cn } from "@band/ui";
import { CheckIcon, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { trpc } from "../../lib/trpc-client";

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface AskUserQuestionProps {
  questions: Question[];
  approvalId: string;
  disabled?: boolean;
}

export function AskUserQuestion({ questions, approvalId, disabled }: AskUserQuestionProps) {
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const toggleOption = useCallback((questionText: string, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const next = { ...prev };
      const current = new Set(prev[questionText] ?? []);
      if (multiSelect) {
        if (current.has(label)) {
          current.delete(label);
        } else {
          current.add(label);
        }
      } else {
        current.clear();
        current.add(label);
      }
      next[questionText] = current;
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const selected = selections[q.question];
        if (selected && selected.size > 0) {
          answers[q.question] = Array.from(selected).join(", ");
        }
      }

      await trpc.chat.answer.mutate({ approvalId, answers });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }, [questions, selections, approvalId]);

  const isDisabled = disabled || submitting || submitted;
  const hasSelections = Object.values(selections).some((s) => s.size > 0);

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      {questions.map((q) => {
        const selected = selections[q.question] ?? new Set<string>();
        return (
          <div key={q.question} className="space-y-2">
            {q.header && (
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {q.header}
              </span>
            )}
            <p className="text-sm font-medium">{q.question}</p>
            <div className="flex flex-wrap gap-2">
              {q.options.map((opt) => {
                const isSelected = selected.has(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => toggleOption(q.question, opt.label, q.multiSelect ?? false)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      isSelected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-foreground hover:bg-muted/50",
                      isDisabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {isSelected && <CheckIcon className="size-3.5 shrink-0" />}
                    <div>
                      <div className="font-medium">{opt.label}</div>
                      {opt.description && (
                        <div className="text-xs text-muted-foreground">{opt.description}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={isDisabled || !hasSelections} onClick={handleSubmit}>
          {submitting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          {submitted ? "Submitted" : "Submit"}
        </Button>
        {submitted && <span className="text-xs text-muted-foreground">Answer sent to agent</span>}
      </div>
    </div>
  );
}
