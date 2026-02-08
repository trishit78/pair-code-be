import type { Request, Response } from "express";
import { pollResult, submitToJudge0 } from "../service/judge0.service.js";
import { normalize } from "../../utils/normalize.js";
import { Submission } from "../model/submission.model.js";
import { wrapJavaScriptCode } from "../templates/template.js";


const LANGUAGE_MAP: Record<string, any> = {
  javascript: 63,
  cpp: 54,
  python: 71
};
function withTimeout<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Judge0 timeout")), ms)
    ),
  ]) as Promise<T>;
}
export const codeRunHandler = async(req:Request,res:Response)=>{
  try{

    const { code, language, input, expectedOutput } = req.body;
    if (!code || !language) {
      return res.status(400).json({ error: "Code and language are required" });
    }

  const finalCode = wrapJavaScriptCode(code, input || "");
  const token = await submitToJudge0(
    finalCode,
    LANGUAGE_MAP[language] || 63,
    input || ""
  );
  const result = await withTimeout(pollResult(token),8000);
  const output = result.stdout || "";
  const passed = expectedOutput 
    ? normalize(output) === normalize(expectedOutput)
    : true;

  res.json({
    status: result.status.description,
    output,
    expected: expectedOutput || "",
    passed,
    compileError: result.compile_output,
    runtimeError: result.stderr
  });
} catch (error) {
    console.error("codeRunHandler error:", error);
    res.status(500).json({ error: "Code execution failed" });
  }
}


export const submissionHandler = async(req:Request,res:Response)=>{
  try {
  const { code, language, input } = req.body;
  const userId = req.user?.id;

  if (!code || !language) {
    return res.status(400).json({ error: "Code and language are required" });
  }

  const finalCode = wrapJavaScriptCode(code, input || "");
  const token = await submitToJudge0(
    finalCode,
    LANGUAGE_MAP[language] || 63,
    input || ""
  );

  const result = await withTimeout(pollResult(token),8000);

  // Save submission to database
  if (userId) {
    await Submission.create({
      userId,
      language: language || "javascript",
      code,
    });
  }

  res.json({
    status: result.status.description,
    output: result.stdout || "",
    compileError: result.compile_output,
    runtimeError: result.stderr
  });
  } catch (error) {
     console.error("codeSubmissionHandler error:", error);
    res.status(500).json({ error: "Code submission failed" });
  }
}