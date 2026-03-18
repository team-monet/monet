declare module "@xenova/transformers" {
  export function pipeline(
    task: "feature-extraction",
    model: string,
    options?: { quantized?: boolean },
  ): Promise<
    (
      input: string,
      options?: { pooling?: string; normalize?: boolean },
    ) => Promise<{ data?: ArrayLike<number> }>
  >;
}
