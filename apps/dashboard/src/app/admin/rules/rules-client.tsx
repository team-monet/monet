"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { Rule, RuleSet } from "@monet/types";
import {
  createRuleAction,
  createRuleSetAction,
  deleteRuleSetAction,
  updateRuleAction,
} from "./actions";
import { initialActionState } from "./actions-shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Scale, Settings2, Calendar, AlertTriangle, Layers, Trash2, ArrowRight, Building2, User } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

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

function useFormActionState<T extends { status: "idle" | "success" | "error"; message: string }>(
  action: (formData: FormData) => Promise<T>,
  initialState: T,
) {
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

function CreateRuleDialog() {
  const [state, pending, formAction] = useFormActionState(createRuleAction, initialActionState);
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
          <DialogTitle>Create New Rule</DialogTitle>
          <DialogDescription>Add a new rule to govern your AI agents.</DialogDescription>
        </DialogHeader>
        <ActionMessage title={state.status === "success" ? "Rule created" : "Could not create rule"} status={state.status} message={state.message} />
        <form action={formAction} className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Rule Name</Label>
            <Input id="name" name="name" required placeholder="e.g. Data Privacy Compliance" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Rule Description</Label>
            <Textarea id="description" name="description" required placeholder="Describe the rule and its application..." className="min-h-[100px]" />
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
  const [state, pending, formAction] = useFormActionState(updateRuleAction, initialActionState);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
          <Settings2 className="h-4 w-4" />
          <span className="sr-only">Edit</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Rule</DialogTitle>
          <DialogDescription>Update this rule's name or description.</DialogDescription>
        </DialogHeader>
        <ActionMessage title={state.status === "success" ? "Rule updated" : "Could not update rule"} status={state.status} message={state.message} />
        <form action={formAction} className="grid gap-4 py-4">
          <input type="hidden" name="ruleId" value={rule.id} />
          <div className="grid gap-2">
            <Label htmlFor={`edit-name-${rule.id}`}>Rule Name</Label>
            <Input id={`edit-name-${rule.id}`} name="name" required defaultValue={rule.name} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`edit-description-${rule.id}`}>Rule Description</Label>
            <Textarea id={`edit-description-${rule.id}`} name="description" required defaultValue={rule.description} className="min-h-[100px]" />
          </div>
          <DialogFooter>
            <SubmitButton label="Save changes" pendingLabel="Saving..." pending={pending} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateRuleSetForm() {
  const [state, pending, formAction] = useFormActionState(createRuleSetAction, initialActionState);
  return (
    <>
      <ActionMessage title={state.status === "success" ? "Rule set created" : "Rule set operation failed"} status={state.status} message={state.message} />
      <form action={formAction} className="space-y-3">
        <div className="grid gap-2">
          <Label htmlFor="rule-set-name">Rule Set Name</Label>
          <Input id="rule-set-name" name="name" required placeholder="e.g. Default Agent Set" />
        </div>
        <SubmitButton label="Create Rule Set" pendingLabel="Creating..." className="w-full" pending={pending} />
      </form>
    </>
  );
}

function DeleteRuleSetForm({ ruleSetId }: { ruleSetId: string }) {
  const [state, pending, formAction] = useFormActionState(deleteRuleSetAction, initialActionState);
  return (
    <>
      <ActionMessage title={state.status === "success" ? "Rule set deleted" : "Rule set operation failed"} status={state.status} message={state.message} />
      <form action={formAction}>
        <input type="hidden" name="ruleSetId" value={ruleSetId} />
        <input type="hidden" name="returnTo" value="/admin/rules" />
        <SubmitButton variant="ghost" size="icon" className="h-8 w-8 text-destructive" pending={pending}>
          <Trash2 className="h-4 w-4" />
          <span className="sr-only">Delete</span>
        </SubmitButton>
      </form>
    </>
  );
}

export function RulesClient({ rules, ruleSets, isAdmin, error }: { rules: Rule[]; ruleSets: RuleSet[]; isAdmin: boolean; error: string }) {
  const ruleNameById = new Map(rules.map((rule) => [rule.id, rule.name]));

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Shared Rules</h1>
          <p className="text-muted-foreground mt-1">
            {isAdmin
              ? "Review and manage the shared rules and rule sets available across this tenant."
              : "Review the shared rules and reusable rule sets available across this tenant."}
          </p>
        </div>

        {isAdmin && <CreateRuleDialog />}
      </div>

      <Tabs defaultValue="rules" className="w-full">
        <TabsList>
          <TabsTrigger value="rules" className="flex items-center gap-2">
            <Scale className="h-4 w-4" />
            Individual Rules
          </TabsTrigger>
          <TabsTrigger value="sets" className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Rule Sets
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Error loading rules</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <Card className="shadow-sm">
              <CardContent className="p-0">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[260px]">Rule Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-[100px]">Scope</TableHead>
                      <TableHead className="w-[140px]">Created</TableHead>
                      <TableHead className="w-[140px]">Updated</TableHead>
                      <TableHead className="w-[80px] text-right"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                          No rules defined yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rules.map((r) => (
                        <TableRow key={r.id} className="group transition-colors">
                          <TableCell className="align-top py-3 whitespace-normal">
                            <div className="flex items-start gap-2">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
                                <Scale className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <span className="block min-w-0 break-words text-sm font-semibold leading-5 line-clamp-2">{r.name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="align-top py-3 whitespace-normal">
                            <span className="block break-words text-sm leading-6 text-muted-foreground line-clamp-3">{r.description}</span>
                          </TableCell>
                          <TableCell className="align-top py-3">
                            {r.ownerUserId ? (
                              <Badge variant="outline" className="gap-1 text-xs">
                                <User className="h-3 w-3" />
                                Personal
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="gap-1 text-xs">
                                <Building2 className="h-3 w-3" />
                                Shared
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="align-top py-3">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Calendar className="h-3 w-3" />
                              {new Date(r.createdAt).toLocaleDateString()}
                            </div>
                          </TableCell>
                          <TableCell className="align-top py-3">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Calendar className="h-3 w-3" />
                              {new Date(r.updatedAt).toLocaleDateString()}
                            </div>
                          </TableCell>
                          <TableCell className="align-top py-3 text-right">{isAdmin && <EditRuleDialog rule={r} />}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="sets" className="mt-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Error loading rule sets</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {isAdmin && (
                <Card className="border-dashed">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Plus className="h-5 w-5 text-primary" />
                      New Rule Set
                    </CardTitle>
                    <CardDescription>Create a reusable bundle of rules for agents.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CreateRuleSetForm />
                  </CardContent>
                </Card>
              )}

              {ruleSets.map((ruleSet) => (
                <Card key={ruleSet.id} className="hover:shadow-md transition-shadow">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Layers className="h-5 w-5 text-primary" />
                      {ruleSet.name}
                    </CardTitle>
                    <CardDescription>
                      {ruleSet.ruleIds.length} {ruleSet.ruleIds.length === 1 ? "rule" : "rules"} in this set.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {ruleSet.ruleIds.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No rules assigned yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {ruleSet.ruleIds.slice(0, 3).map((ruleId) => (
                          <div key={ruleId} className="flex items-center gap-2 text-sm">
                            <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                            <span className="truncate">{ruleNameById.get(ruleId) ?? ruleId}</span>
                          </div>
                        ))}
                        {ruleSet.ruleIds.length > 3 && <p className="text-xs text-muted-foreground">+{ruleSet.ruleIds.length - 3} more</p>}
                      </div>
                    )}
                  </CardContent>
                  <CardFooter className="pt-0 flex gap-2">
                    <Button asChild variant="outline" size="sm" className="flex-1">
                      <Link href={`/admin/rules/sets/${ruleSet.id}`}>
                        {isAdmin ? "Manage Set" : "View Set"}
                        <ArrowRight className="ml-2 h-3.5 w-3.5" />
                      </Link>
                    </Button>
                    {isAdmin && <DeleteRuleSetForm ruleSetId={ruleSet.id} />}
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
