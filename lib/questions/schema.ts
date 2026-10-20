import { z } from "zod";

import { plainText } from "@/lib/reviews/schema";

export const questionInputSchema = z
  .object({
    body: plainText(1, 500, "your question"),
    bookId: z.uuid().optional(),
    ideaId: z.uuid().optional(),
  })
  .refine((input) => input.bookId !== undefined || input.ideaId !== undefined, {
    error: "Choose a book or an idea to ask about.",
    path: ["target"],
  });
export type QuestionInput = z.infer<typeof questionInputSchema>;
