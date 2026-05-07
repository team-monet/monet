"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { Rule, RuleSet } from "@monet/types";
import {
  createPersonalRuleAction,
  createPersonalRuleSetAction,
  deletePersonalRuleAction,
  deletePersonalRuleSetAction,
  updatePersonalRuleAction,
} from "./actions";
import { initialActionState } from "./actions-shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Calendar, Layers, Pencil, Plus, Scale, Trash2 } from "lucide-react";

function ActionMessage({ title, status, message }: { title: string; status: "idle" | "success" | "error"; message: string }) {
  if (status === "idle" || !message) return null;
  return (
    <Alert variant={status === "error" ? "destructive" : "default"}>
      {status === "error" && <AlertTriangle className="h-4 w-4" />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function useFormActionState<T extends { status: "idle" | "success" | "error"; message: string }>(action: (formData: FormData) => Promise<T>, initialState: T) {
  const [state, setState] = useState(initialState);
  const [pending, startTransition] = useTransition();
  const formAction = (formData: FormData) => {
    startTransition(async () => {
      try {
        setState(await action(formData));
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" } as T);
      }
    });
  };
  return [state, pending, formAction] as const;
}

function CreateRuleSetDialog() {
  const [state, pending, formAction] = useFormActionState(createPersonalRuleSetAction, initialActionState);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Layers className="mr-2 h-4 w-4" />
          Create Rule Set
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Personal Rule Set</DialogTitle>
          <DialogDescription>Group your personal rules into a reusable set.</DialogDescription>
        </DialogHeader>
        <ActionMessage title={state.status === "success" ? "Rule set created" : "Rule set operation failed"} status={state.status} message={state.message} />
        <form action={formAction} className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="rule-set-name">Rule Set Name</Label>
            <Input id="rule-set-name" name="name" required placeholder="e.g. My Research Defaults" />
          </div>
          <DialogFooter>
            <SubmitButton label="Create Rule Set" pendingLabel="Creating..." pending={pending} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateRuleDialog() {
  const [state, pending, formAction] = useFormActionState(createPersonalRuleAction, initialActionState);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Create Rule
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create Personal Rule</DialogTitle>
          <DialogDescription>Add guidance that applies only to you and your agents.</DialogDescription>
        </DialogHeader>
        <ActionMessage title={state.status === "success" ? "Rule created" : "Could not create rule"} status={state.status} message={state.message} />
        <form action={formAction} className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Rule Name</Label>
            <Input id="name" name="name" required placeholder="e.g. Ask Before Publishing Drafts" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Rule Description</Label>
            <Textarea id="description" name="description" required placeholder="Describe how your agents should behave..." className="min-h-[120px]" />
          </div>
          <DialogFooter>
            <SubmitButton label="Create Rule" pendingLabel="Creating..." pending={pending} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditRuleDialog({ rule }: { rule: Rule }) {
  const [state, pending, formAction] = useFormActionState(updatePersonalRuleAction, initialActionState);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Pencil className="h-4 w-4" />
          <span className="sr-only">Edit</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Personal Rule</DialogTitle>
          <DialogDescription>Update the name or description for this rule.</DialogDescription>
        </DialogHeader>
        <ActionMessage title={state.status === "success" ? "Rule updated" : "Could not update rule"} status={state.status} message={state.message} />
        <form action={formAction} className="grid gap-4 py-4">
          <input type="hidden" name="ruleId" value={rule.id} />
          <div className="grid gap-2">
            <Label htmlFor={`edit-rule-name-${rule.id}`}>Rule Name</Label>
            <Input id={`edit-rule-name-${rule.id}`} name="name" required defaultValue={rule.name} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`edit-rule-description-${rule.id}`}>Rule Description</Label>
            <Textarea id={`edit-rule-description-${rule.id}`} name="description" required defaultValue={rule.description} className="min-h-[120px]" />
          </div>
          <DialogFooter>
            <SubmitButton label="Save Changes" pendingLabel="Saving..." pending={pending} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRuleForm({ ruleId }: { ruleId: string }) {
  const [state, pending, formAction] = useFormActionState(deletePersonalRuleAction, initialActionState);
  return (
    <>
      <ActionMessage title={state.status === "success" ? "Rule deleted" : "Could not delete rule"} status={state.status} message={state.message} />
      <form action={formAction}>
        <input type="hidden" name="ruleId" value={ruleId} />
        <input type="hidden" name="returnTo" value="/rules" />
        <SubmitButton variant="ghost" size="icon" className="h-8 w-8" pending={pending} >
          <Trash2 className="h-4 w-4" />
          <span className="sr-only">Delete</span>
        </SubmitButton>
      </form>
    </>
  );
}

function DeleteRuleSetForm({ ruleSetId }: { ruleSetId: string }) {
  const [state, pending, formAction] = useFormActionState(deletePersonalRuleSetAction, initialActionState);
  return (
    <>
      <ActionMessage title={state.status === "success" ? "Rule set deleted" : "Rule set operation failed"} status={state.status} message={state.message} />
      <form action={formAction}>
        <input type="hidden" name="ruleSetId" value={ruleSetId} />
        <input type="hidden" name="returnTo" value="/rules" />
        <SubmitButton label="Delete" pendingLabel="Deleting..." variant="outline" size="sm" pending={pending}/>
      </form>
    </>
  );
}

export function RulesClient({ rules, ruleSets, error }: { rules: Rule[]; ruleSets: RuleSet[]; error: string }) {
  const ruleNameById = new Map(rules.map((rule) => [rule.id, rule.name]));

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">My Rules</h1>
          <p className="mt-1 text-muted-foreground">Create personal guidance you can reuse across your own agents.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <CreateRuleSetDialog />
          <CreateRuleDialog />
        </div>
      </div>

      <Card className="border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Shared Rules Catalog</CardTitle>
          <CardDescription>Browse the tenant-wide shared guidance separately from your personal rules.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="ghost" className="px-0">
            <Link href="/admin/rules">Open Shared Rules</Link>
          </Button>
        </CardContent>
      </Card>

      <Tabs defaultValue="rules" className="w-full">
        <TabsList>
          <TabsTrigger value="rules" className="flex items-center gap-2">
            <Scale className="h-4 w-4" />
            Personal Rules
          </TabsTrigger>
          <TabsTrigger value="sets" className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Personal Rule Sets
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-6">
          {error ? (
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Error loading rules</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
          ) : (
            <Card className="shadow-sm"><CardContent className="p-0"><Table className="table-fixed"><TableHeader><TableRow><TableHead className="w-[260px]">Rule Name</TableHead><TableHead>Description</TableHead><TableHead className="w-[140px]">Created</TableHead><TableHead className="w-[140px]">Updated</TableHead><TableHead className="w-[120px] text-right" /></TableRow></TableHeader><TableBody>{rules.length === 0 ? (<TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No personal rules yet.</TableCell></TableRow>) : (rules.map((rule) => (<TableRow key={rule.id} className="group"><TableCell className="align-top py-3 whitespace-normal"><div className="flex items-start gap-2"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted"><Scale className="h-4 w-4 text-muted-foreground" /></div><span className="block min-w-0 break-words text-sm font-semibold leading-5 line-clamp-2">{rule.name}</span></div></TableCell><TableCell className="align-top py-3 whitespace-normal"><span className="block break-words text-sm leading-6 text-muted-foreground line-clamp-3">{rule.description}</span></TableCell><TableCell className="align-top py-3"><div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Calendar className="h-3 w-3" />{new Date(rule.createdAt).toLocaleDateString()}</div></TableCell><TableCell className="align-top py-3"><div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Calendar className="h-3 w-3" />{new Date(rule.updatedAt).toLocaleDateString()}</div></TableCell><TableCell className="align-top py-3 text-right"><div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100"><EditRuleDialog rule={rule} /><DeleteRuleForm ruleId={rule.id} /></div></TableCell></TableRow>)))}</TableBody></Table></CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="sets" className="mt-6">
          {error ? (
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Error loading rule sets</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
          ) : (
            <Card className="shadow-sm">
              <CardHeader><CardTitle>Personal Rule Sets</CardTitle><CardDescription>Reusable collections of your personal rules.</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                {ruleSets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No personal rule sets yet.</p>
                ) : (
                  ruleSets.map((ruleSet) => (
                    <div key={ruleSet.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                      <div className="space-y-1"><Link href={`/rules/sets/${ruleSet.id}`} className="font-medium hover:underline">{ruleSet.name}</Link><p className="text-xs text-muted-foreground">{ruleSet.ruleIds.length} {ruleSet.ruleIds.length === 1 ? "rule" : "rules"}{ruleSet.ruleIds.length > 0 && <>: {ruleSet.ruleIds.map((ruleId) => ruleNameById.get(ruleId) ?? "Unknown rule").join(", ")}</>}</p></div>
                      <DeleteRuleSetForm ruleSetId={ruleSet.id} />
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
