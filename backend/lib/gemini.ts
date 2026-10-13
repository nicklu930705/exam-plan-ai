import { GoogleGenAI } from '@google/genai';
import type { StructuredAdvice, StudyAdviceRequest } from './types';

const DEFAULT_MODEL = 'gemini-2.5-flash';

const SYSTEM_INSTRUCTION = `你是一位專業、親切且實事求是的繁體中文升學與證照考試備考教練。
你的任務是根據考生提供的「考試名稱、考試日期、每日可讀書時間、科目清單、熟悉程度、完成率與落後任務數」，提供具有啟發性、可行性且具體明確的讀書建議。

【核心原則】
1. 恪守職責分工：你只提供策略分析、心理激勵與複習技巧，絕對不可自行編造具體的每日日期排程。所有每日日程與時間上限由系統排程引擎安全計算。
2. 語言規範：一律使用繁體中文（台灣慣用語，例如：衝刺、複習、歷屆試題、章節、落後、進度）。
3. 輸出必須是符合下列架構的合法 JSON，不要輸出任何額外的開場白或結尾問候：
{
  "summary": "一段約 80~120 字的策略評估與暖心鼓勵，指出目前準備的核心焦點",
  "focusSubjects": ["建議本週重點加強的科目 1", "科目 2"],
  "actionableTips": [
    "具體行動建議 1 (例如：如何利用每日黃金時間切入弱科)",
    "具體行動建議 2 (例如：針對落後任務的補齊或計時技巧)",
    "具體行動建議 3 (例如：考前衝刺心態與複習節奏)"
  ],
  "estimatedFeasibility": "對目前每日可用讀書時間是否足以負荷考試目標的客觀評估 (例如：每日 90 分鐘時間充裕，維持規律即可順利完成全部範圍)"
}`;

/**
 * 呼叫 Google Gemini API 產生結構化讀書建議
 */
export async function generateGeminiAdvice(
  req: StudyAdviceRequest,
  apiKey: string,
  modelName: string = DEFAULT_MODEL,
): Promise<StructuredAdvice> {
  const ai = new GoogleGenAI({ apiKey });

  const subjectDetails = req.subjects
    .map((s) => {
      const famText = s.familiarity === 1 ? '不熟 (待加強)' : s.familiarity === 2 ? '普通' : '熟悉';
      return `• ${s.name}：熟悉度「${famText}」${
        s.totalChapters ? ` (總章節: ${s.totalChapters}，已完成: ${s.completedChapters ?? 0})` : ''
      }`;
    })
    .join('\n');

  const userPrompt = `【考生資料】
考試名稱：${req.examName}
考試日期：${req.examDate}
每日可用讀書時間：${req.dailyAvailableMinutes} 分鐘
讀書強度偏好：${req.intensity ?? 'normal'}
近期整體任務完成率：${req.recentCompletionRate !== undefined ? `${req.recentCompletionRate}%` : '尚無紀錄'}
目前落後未完成之任務數：${req.behindTasksCount ?? 0} 項

【各科掌握狀態】
${subjectDetails}

請根據以上資料，評估考生的備考策略，並依格式回傳繁體中文 JSON 建議。`;

  const response = await ai.models.generateContent({
    model: modelName,
    contents: userPrompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  });

  const text = response.text?.trim() || '';
  if (!text) {
    throw new Error('Gemini API 未回傳有效文字內容。');
  }

  // 清除可能包夾的 Markdown 標記 (```json ... ```)
  const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<StructuredAdvice>;

    return {
      summary: parsed.summary || '持續保持規律複習，按部就班推進各科重點。',
      focusSubjects: Array.isArray(parsed.focusSubjects) && parsed.focusSubjects.length > 0
        ? parsed.focusSubjects
        : [req.subjects[0]?.name || '主要科目'],
      actionableTips: Array.isArray(parsed.actionableTips) && parsed.actionableTips.length > 0
        ? parsed.actionableTips
        : [
            '優先安排熟悉度較低的科目於精神最佳時段研讀。',
            '使用 App 專注計時器保持節奏，避免長時間分心。',
            '善用系統排程之休息日與緩衝時段補齊落後章節。',
          ],
      estimatedFeasibility:
        parsed.estimatedFeasibility ||
        `目前每天 ${req.dailyAvailableMinutes} 分鐘讀書時間，只要持之以恆，進度完全在掌握之中。`,
    };
  } catch (parseErr) {
    console.error('[Gemini] JSON 解析失敗，原始內容：', text, parseErr);
    throw new Error('無法解析 Gemini 回傳的結構化資料。');
  }
}
