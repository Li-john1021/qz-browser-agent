from __future__ import annotations

from dataclasses import replace

from .cases import CaseSpec


# Authored task prompts preserve the same fixtures and acceptance contract in each language.
# Never include expected fixture answers: the live Agent must discover them through its tools.
PROMPTS = {
    "en": {
        "goal_driven_pagination": """
This is a multi-page collection task. Use goal tracking.
Starting at {base_url}/posts?page=1, visit all 3 pages and collect title, author, url, and page for all 9 posts. Write them to the data_store table {table}, with url as the dedupField.
Before starting, create the goal. After each durable write to data_store, checkpoint the goal. Before finishing, use list to verify that there are exactly 9 records and no duplicates. Finally, complete the goal and give a brief summary in English.
""",
        "document_pipeline": """
Turn the remote text at {base_url}/docs/sample.txt into a qz document summary artifact.
This task specifically tests the global qingzhou-documents skill: first use load_skill to load qingzhou-documents, then use its document_fetch, document_parse, document_read_chunk, and document_create tools in that order. Do not substitute open_tab, read_article, or save_file.
Fetch and parse the text, read its first paragraph, and create a txt artifact titled Qingzhou regression document summary without triggering a download.
Write the workflow result to the qz Data table {table}, using step as the dedupField. Include at least one record with step=document_pipeline_completed and the fileId, docModelId, and artifactId.
Before finishing, verify that the table contains at least 1 record. Give your final response in English.
""",
        "parallel_subtasks": """
Check these three independent local branches in parallel. Inspect the first result as soon as one branch finishes, then wait for all branches to finish before summarizing:
- Alpha: {base_url}/parallel/alpha
- Beta: {base_url}/parallel/beta
- Gamma: {base_url}/parallel/gamma

Use the exact fields branch, code, status, and url for each result. For an available branch, preserve the code and status values exactly as shown on its page. For an unavailable branch, set status=unavailable and code="" (an empty string); do not guess its code.
Write the three final results to the qz Data table {table}, using branch as the unique key. Before finishing, verify that there are exactly 3 rows. Give your final response in English.
""",
    },
    "ja": {
        "goal_driven_pagination": """
複数ページにわたる情報収集を、目標管理を使って進めてください。
{base_url}/posts?page=1 から始めて全 3 ページを巡回し、全 9 件の投稿の title、author、url、page を収集してください。data_store のテーブル {table} に保存し、dedupField は url にしてください。
作業を始める前に目標を create してください。data_store への永続的な書き込みが完了するたびに checkpoint を記録してください。完了前に list で重複がなく、ちょうど 9 件あることを確認してください。最後に目標を complete し、結果を日本語で簡潔に報告してください。
""",
        "document_pipeline": """
{base_url}/docs/sample.txt のテキストを取得し、軽舟の文書要約アーティファクトを作成してください。
これはグローバル Skill「qingzhou-documents」の動作確認です。まず load_skill で qingzhou-documents を読み込み、その document_fetch、document_parse、document_read_chunk、document_create をこの順番で使ってください。open_tab、read_article、save_file で代用しないでください。
テキストを取得・解析して最初の段落を読み、タイトルが Qingzhou regression document summary の txt アーティファクトを作成してください。ダウンロードは実行しないでください。
処理結果を軽舟の Data テーブル {table} に保存し、dedupField は step にしてください。少なくとも step=document_pipeline_completed のレコードを 1 件作成し、fileId、docModelId、artifactId を含めてください。
完了前にテーブルに 1 件以上あることを確認してください。最後の回答は日本語でお願いします。
""",
        "parallel_subtasks": """
次の独立した 3 つのローカル分岐を並行して確認してください。最初の 1 つが完了した時点でその結果を確認し、その後すべての分岐が完了するのを待ってから集約してください。
- Alpha: {base_url}/parallel/alpha
- Beta: {base_url}/parallel/beta
- Gamma: {base_url}/parallel/gamma

結果のフィールド名は branch、code、status、url にしてください。利用できる分岐の code と status は、ページで実際に確認した値をそのまま保存してください。利用できない分岐は status=unavailable、code=""（空文字列）とし、code を推測しないでください。
最終的な 3 件の結果を軽舟の Data テーブル {table} に保存し、一意キーには branch を使ってください。完了前にちょうど 3 行あることを確認してください。最後の回答は日本語でお願いします。
""",
    },
    "ar": {
        "goal_driven_pagination": """
هذه مهمة لجمع البيانات من عدة صفحات. استخدم تتبع الأهداف لتنفيذها.
ابدأ من {base_url}/posts?page=1 وتصفح الصفحات الـ 3 كلها، واجمع حقول title وauthor وurl وpage لجميع المنشورات الـ 9. احفظها في جدول data_store المسمى {table}، واستخدم url لحقل dedupField.
أنشئ الهدف باستخدام create قبل بدء العمل. بعد كل كتابة دائمة إلى data_store، سجل نقطة تقدم باستخدام checkpoint. قبل الانتهاء، استخدم list للتحقق من وجود 9 سجلات بالضبط دون تكرار. أخيرًا، أكمل الهدف باستخدام complete وقدم ملخصًا موجزًا بالعربية.
""",
        "document_pipeline": """
حوّل النص المتاح على {base_url}/docs/sample.txt إلى ملف يلخص المستند داخل qz.
هذه المهمة تختبر تحديدًا المهارة العامة qingzhou-documents: ابدأ بتحميل qingzhou-documents باستخدام load_skill، ثم استخدم أدواتها document_fetch وdocument_parse وdocument_read_chunk وdocument_create بهذا الترتيب. لا تستبدلها بأدوات open_tab أو read_article أو save_file.
اجلب النص وحلله واقرأ فقرته الأولى، ثم أنشئ ملف txt بعنوان Qingzhou regression document summary دون بدء تنزيله.
احفظ نتيجة سير العمل في جدول Data داخل qz المسمى {table}، واستخدم step لحقل dedupField. أضف سجلًا واحدًا على الأقل يحتوي على step=document_pipeline_completed وحقول fileId وdocModelId وartifactId.
قبل الانتهاء، تحقق من وجود 1 سجل على الأقل في الجدول. اكتب ردك النهائي بالعربية.
""",
        "parallel_subtasks": """
تحقق بالتوازي من الفروع المحلية الثلاثة المستقلة التالية. افحص نتيجة أول فرع فور اكتماله، ثم انتظر اكتمال جميع الفروع قبل تلخيص النتائج:
- Alpha: {base_url}/parallel/alpha
- Beta: {base_url}/parallel/beta
- Gamma: {base_url}/parallel/gamma

استخدم أسماء الحقول branch وcode وstatus وurl لكل نتيجة. للفروع المتاحة، احتفظ بقيمتي code وstatus كما تظهران في الصفحة تمامًا. إذا كان الفرع غير متاح، فاكتب status=unavailable وcode="" (سلسلة نصية فارغة)، ولا تخمن قيمة code.
احفظ النتائج النهائية الثلاث في جدول Data داخل qz المسمى {table}، واستخدم branch مفتاحًا فريدًا. قبل الانتهاء، تحقق من وجود 3 صفوف بالضبط. اكتب ردك النهائي بالعربية.
""",
    },
}


def localize_case(case: CaseSpec, language: str, base_url: str) -> CaseSpec:
    if language == "zh-CN":
        return case
    if language not in PROMPTS:
        raise ValueError(f"Unsupported live task language: {language}")
    if case.name not in PROMPTS[language]:
        raise ValueError(f"No {language} live task prompt for case: {case.name}")
    prompt = PROMPTS[language][case.name].format(base_url=base_url, table=case.table).strip()
    return replace(case, prompt=prompt)
