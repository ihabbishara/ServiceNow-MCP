import type { CreateWorkItemPayload } from "./types.js";

export interface FieldOp {
  referenceName: string;
  value: string | number;
}

/**
 * Field assignments shared by the REST json-patch body and the az CLI
 * `--fields` flag. Title/area/iteration/assignee are excluded: each client
 * sets those through its own mechanism (patch ops vs dedicated flags).
 */
export const workItemFieldOps = (p: CreateWorkItemPayload): FieldOp[] => {
  const ops: FieldOp[] = [];
  if (p.description != null) {
    const html = p.description.replace(/\n/g, "<br>");
    ops.push({
      referenceName: p.type === "Bug" ? "Microsoft.VSTS.TCM.ReproSteps" : "System.Description",
      value: html
    });
  }
  if (p.tags?.length) ops.push({ referenceName: "System.Tags", value: p.tags.join("; ") });
  const prio = p.priority ? Number(p.priority) : NaN;
  if (Number.isInteger(prio) && prio >= 1 && prio <= 4)
    ops.push({ referenceName: "Microsoft.VSTS.Common.Priority", value: prio });
  if (typeof p.storyPoints === "number")
    ops.push({ referenceName: "Microsoft.VSTS.Scheduling.StoryPoints", value: p.storyPoints });
  for (const [k, v] of Object.entries(p.fields ?? {})) ops.push({ referenceName: k, value: v });
  return ops;
};
