// Contact sheet: candidate groups by arm/recipe (nano-banana-2 web/app.js
// renderCandidateGroups). Each group = recipe name + a collapsible "Style recipe and full
// prompt", then a grid of candidate cards — 4-up desktop, 2-up narrow, all candidates
// visible, never horizontal-scroll (Mantine SimpleGrid uses minmax(0,1fr) tracks). React
// state drives incremental fill-in; no manual DOM diffing.

import { ActionIcon, CopyButton, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { Check, Copy } from "@phosphor-icons/react";

import type { SessionManifest, SessionRepository } from "../core/session";
import { CandidateCard } from "./CandidateCard";
import classes from "./SessionView.module.css";

export interface ContactSheetProps {
  repo: SessionRepository;
  manifest: SessionManifest;
  focusedCandidateId: string | undefined;
  // Export selection (the tray). A Set of candidate ids, owned by SessionView, independent of
  // focus and Primary.
  exportSelectedIds: Set<string>;
  onToggleExport: (candidateId: string) => void;
  onFocus: (candidateId: string) => void;
}

export function ContactSheet({
  repo,
  manifest,
  focusedCandidateId,
  exportSelectedIds,
  onToggleExport,
  onFocus,
}: ContactSheetProps) {
  return (
    <Stack gap={0}>
      {manifest.arms.map((arm) => (
        <section
          key={arm.id}
          className={classes.group}
          aria-labelledby={`arm-${arm.id}`}
        >
          <div>
            <Title order={3} fz="h5" id={`arm-${arm.id}`}>
              {arm.recipe.name}
            </Title>
            <details>
              <summary style={{ cursor: "pointer", fontSize: "var(--mantine-font-size-xs)" }}>
                Style recipe and full prompt
              </summary>
              {/* P16: icon-only copy control pinned to the block's top-right corner —
                  inset past the slim scrollbar, with a matching text gutter reserved in
                  .prompt so no prompt line ever runs under it. */}
              <div className={classes.promptWrap}>
                <pre className={classes.prompt}>{arm.renderedPrompt}</pre>
                <CopyButton value={arm.renderedPrompt} timeout={1500}>
                  {({ copied, copy }) => (
                    <ActionIcon
                      className={classes.promptCopy}
                      variant="default"
                      size="sm"
                      aria-label={copied ? "Copied" : "Copy full prompt"}
                      onClick={copy}
                    >
                      {copied ? (
                        <Check size={14} aria-hidden color="var(--mantine-color-workbench-light-color)" />
                      ) : (
                        <Copy size={14} aria-hidden />
                      )}
                    </ActionIcon>
                  )}
                </CopyButton>
              </div>
            </details>
          </div>

          {/* 4-up on wide screens, 2-up below ~1180px (source candidate-grid), never
              horizontal-scroll — SimpleGrid tracks are minmax(0,1fr). */}
          <SimpleGrid cols={{ base: 2, lg: 4 }} spacing="sm" mt="sm">
            {arm.candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                repo={repo}
                subject={manifest.subject}
                arm={arm}
                candidate={candidate}
                focused={focusedCandidateId === candidate.id}
                primary={manifest.selectedCandidateId === candidate.id}
                exportSelected={exportSelectedIds.has(candidate.id)}
                onToggleExport={onToggleExport}
                onFocus={onFocus}
              />
            ))}
          </SimpleGrid>
        </section>
      ))}
      {manifest.arms.length === 0 && (
        <Text c="dimmed" fz="sm">
          No style recipes in this run.
        </Text>
      )}
    </Stack>
  );
}
