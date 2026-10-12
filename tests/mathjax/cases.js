(function installMathjaxCases(global) {
  function buildMathjaxCases() {
    const cases = [
      ["inline-dollar-single-uppercase-variable", "Variable $X$ appears inline.", 1],
      ["inline-dollar-single-lowercase-variable", "Variable $x$ appears inline.", 1],
      ["inline-dollar-simple", "Energy $E=mc^2$ in a sentence.", 1],
      ["inline-paren-simple", "Energy \\(E=mc^2\\) in a sentence.", 1],
      ["display-dollar-simple", "$$E=mc^2$$", 1],
      ["display-dollar-block-lines", "$$\n\\mathcal{J}(\\theta)=\\mathbb{E}\\left[\\frac{1}{G}\\sum_{i=1}^{G} r_i\\right]\n$$", 1],
      ["boxed-display-unwrapped", "$$\\boxed{E=mc^2}$$", 1],
      ["fbox-inline-unwrapped", "Inline \\(\\fbox{x_i + y_i}\\) text.", 1],
      ["bbox-display-unwrapped", "\\[\\bbox[border:1px solid red]{\\sum_i x_i}\\]", 1],
      ["display-bracket-simple", "\\[E=mc^2\\]", 1],
      ["display-bracket-block-lines", "\\[\n\\sum_{i=1}^{n} x_i^2\n\\]", 1],
      ["mixed-inline-display", "Inline $x_i^2$ then block $$\\sum_{i=1}^n x_i$$ end.", 2],
      ["tex-fence", "```tex\n\\frac{a}{b} + \\sqrt{x}\n```", 1],
      ["latex-fence", "```latex\n\\int_0^1 x^2 dx\n```", 1],
      ["math-fence", "```math\n\\arg\\max_\\theta p(y|x;\\theta)\n```", 1],
      ["opd-plain-fence-1", "```\nmin_\\theta D_f(( student_\\theta(.|teacher_prefix) || teacher(.|teacher_prefix) ))\n```", 1],
      ["opd-plain-fence-2", "```\nmin_\\theta D_f(( student_\\theta(.|student_prefix) || teacher(.|student_prefix) ))\n```", 1],
      ["json-not-math", "```json\n{\"x_i\": 1, \"price\": \"$5\"}\n```", 0],
      ["js-not-math", "```js\nconst x_i = 1; return x_i;\n```", 0],
      ["url-query-not-math", "```\nhttps://dashboard.example.test/app/template?kiosk=true&app_name=example-100\n```", 0],
      ["env-assignment-not-math", "```\nDATABASE_URL=https://db.example.com/app\n```", 0],
      ["log-fields-not-math", "```\nrequest_id=abc status_code=200\n```", 0],
      ["workflow-snake-case-not-math", "```\nopen_tab → get_ax_tree / run_script → read_article\n```", 0],
      ["text-language-is-not-math", "```text\nx_i = y_i + z_i\n```", 0],
      ["code-span-not-math", "Code `$x_i$` then real $x_i$.", 1],
      ["escaped-dollar-not-math", "Escaped \\$x_i\\$ should stay text.", 0],
      ["price-not-math", "Prices are $5 and $10, not formulas.", 0],
      ["unmatched-dollar-not-math", "A broken $x_i formula should not explode.", 0],
      ["space-dollar-not-math", "A spaced $ x_i $ example should stay text.", 0],
      ["link-with-dollar-not-math", "[price $5](https://example.com) and $x+y$.", 1],
      ["align-env", "\\[\\begin{align} a&=b+c\\\\ d&=e+f \\end{align}\\]", 1],
      ["matrix", "$$\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}$$", 1],
      ["cases-env", "$$f(x)=\\begin{cases}x^2,&x>0\\\\0,&x\\le 0\\end{cases}$$", 1],
      ["undefined-command-no-crash", "$$\\notarealcommand{x}+1$$", 1],
      ["mathsf-snake-code", "```\n\\mathsf{question}_\\mathsf{only}_\\mathsf{context} = 视频帧 + 音频 + \\mathsf{caption} + \\mathsf{title}\n```", 1],
      ["chained-subscript-inline-text", "\\(\\text{更新}\\;π_θ_\\mathsf{old}\\;←\\;π_θ\\;(\\text{每}\\;N\\;\\text{步})\\)", 1],
      ["chained-subscript-code-lines", "```\n\\(\\text{对于每个}\\;\\mathsf{batch}：\\)\n\\(1.\\;\\text{对每个问题}\\;q，\\text{从}\\;π_θ_\\mathsf{old}\\;\\text{采样}\\;G\\;\\text{个输出}\\;{o_{1},...,o_{G}}\\)\n\\(2.\\;\\text{计算每个输出的}\\;\\mathsf{reward}\\;R_{i}\\)\n\\(3.\\;\\text{组内归一化得到优势}\\;A_{i}\\)\n\\(4.\\;\\text{计算}\\;\\mathsf{clipped}\\;\\mathsf{surrogate}\\;+\\;\\mathsf{KL}\\;\\mathsf{penalty}\\)\n\\(5.\\;\\text{梯度下降优化}\\;J_{GRPO}(θ)\\)\n\\(6.\\;\\text{更新}\\;π_θ_\\mathsf{old}\\;←\\;π_θ\\;(\\text{每}\\;N\\;\\text{步})\\)\n```", 7],
      ["snake-case-pseudocode-not-math", "```\nquestion_only_context = 视频帧 + 音频 + caption + title\nstudent_rollout = question_only_context -> response\n```", 0],
      ["state-object-code-like-math", "```\n\\[\\mathsf{s\\_t} = \\{\nvideoprefix/fullvideofeatures,\nalready_generated_chapters : c_1...c_{t-1},\ncurrenttimestamp/candidatesegment\n\\}\n\\]\n```", 5],
      ["inline-delimited-state-object", "```\n\\(\\mathsf{s\\_t} = {\\)\n  videoprefix/fullvideofeatures,\n  already_generated_chapters : c_1...c_{t-1},\n  currenttimestamp/candidatesegment\n}\n```", 5, [0, 2, 2, 2, 0]],
      ["inline-delimited-action-object", "```\n\\(\\mathsf{a\\_t} = {\\)\n  boundary_decision : 是否在当前时间点切一章，\n  chapter_title_tokens : 如果切章，生成标题\n}\n```", 4, [0, 2, 2, 0]],
      ["plain-input-object", "```\n\\(x = {\\)\n  video_frames,\n  audio,\n  caption,\n  title,\n  metadata\n}\n```", 7, [0, 2, 2, 2, 2, 2, 0]],
    ];

    const inlineOps = ["+", "-", "\\\\cdot", "\\\\times", "\\\\leq", "\\\\geq"];
    for (let i = 0; i < 30; i += 1) {
      const op = inlineOps[i % inlineOps.length];
      cases.push([`generated-inline-${i}`, `Generated inline $x_${i} ${op} y_${i} = z_${i}$ with text.`, 1]);
    }

    const displayTemplates = [
      i => `$$\\sum_{k=1}^{${i + 2}} k^2 = \\frac{${i + 2}(${i + 3})(2${i + 2}+1)}{6}$$`,
      i => `\\[p_${i}(y|x)=\\frac{\\exp(s_${i}(y))}{\\sum_j \\exp(s_${i}(j))}\\]`,
      i => `$$\\mathbb{E}_{x\\sim P_${i}}[f(x)] \\approx \\frac{1}{n}\\sum_i f(x_i)$$`,
    ];
    for (let i = 0; i < 30; i += 1) {
      cases.push([`generated-display-${i}`, `Block case ${i}\n\n${displayTemplates[i % displayTemplates.length](i)}`, 1]);
    }

    for (let i = 0; i < 24; i += 1) {
      cases.push([
        `generated-plain-fence-${i}`,
        `\`\`\`\nargmax_\\theta \\sum_{i=1}^{n} log p_\\theta(y_${i}|x_${i}) - \\lambda ||\\theta||_2^2\n\`\`\``,
        1,
      ]);
    }

    for (let i = 0; i < 16; i += 1) {
      cases.push([
        `generated-negative-${i}`,
        `No formula here: order #${i} costs $${i + 3}, env $HOME_${i}, and code \`a_${i}\`.`,
        0,
      ]);
    }
    return cases;
  }

  function buildMathjaxStreamScenario() {
    const markdown = [
      "Partial stream starts with $X$",
      " then $x_i$",
      " and later shows:",
      "\n\n$$\n\\sum_{i=1}^{n} x_i^2\n$$",
      "\n\nDone.",
    ].join("");
    const singleVarStart = markdown.indexOf("$X");
    const singleVarClose = markdown.indexOf("$", singleVarStart + 1) + 1;
    const subscriptVarStart = markdown.indexOf("$x_i");
    const subscriptVarClose = markdown.indexOf("$", subscriptVarStart + 1) + 1;
    const displayStart = markdown.indexOf("$$\n\\sum");
    const displayClose = markdown.indexOf("$$", displayStart + 2) + 2;
    return {
      markdown,
      checkpoints: [
        singleVarStart + 2,
        singleVarClose,
        subscriptVarStart + 4,
        subscriptVarClose,
        displayStart + 8,
        displayClose,
        markdown.length,
      ],
      expectedCounts: [0, 1, 1, 2, 2, 3, 3],
      expectedPendingCounts: [1, 0, 1, 0, 1, 0, 0],
    };
  }

  function buildMathjaxStreamCodeBlockScenario() {
    const markdown = [
      "伪代码：\n\n",
      "```\n",
      "1. 从 dataset 采样 batch 的问题 q\n",
      "2. \\text{对每个}\\;q, \\text{从}\\;\\pi_\\theta \\mathsf{old}\\;\\text{采样}\\;G\\;\\text{个输出}\n",
      "3. 用 reward model 对每个 o_i 打分得到 r_i\n",
      "```\n",
      "完成。",
    ].join("");
    const line2Start = markdown.indexOf("2. \\text");
    const line2End = markdown.indexOf("\n3.", line2Start) + 1;
    const line3Start = markdown.indexOf("3. 用");
    const line3End = markdown.indexOf("\n```", line3Start) + 1;
    return {
      markdown,
      checkpoints: [
        line2Start + 58,
        line2End,
        line3Start + 26,
        line3End,
        markdown.length,
      ],
      expectedRenderedCounts: [1, 2, 2, 3, 3],
      expectedPendingCounts: [1, 0, 1, 0, 0],
      stableLineKeyIndex: 1,
      stableLineKeyFrames: [1, 2, 3, 4],
    };
  }

  global.QingzhouMathjaxCases = {
    buildMathjaxCases,
    buildMathjaxStreamScenario,
    buildMathjaxStreamCodeBlockScenario,
  };
})(window);
