import { expect, test } from "./sidepanel-fixtures.mjs";

test("landing-only scroll rules do not leak into conversation layout", async ({ page }) => {
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");

  const landing = await readMessagesLayout(page);
  expect(landing).toMatchObject({
    state: "landing",
    overflowY: "hidden",
    topGap: 0,
    leftInset: 14,
    rightInset: 14,
  });

  const conversation = await page.evaluate(() => {
    const messages = document.querySelector("#messages");
    const welcome = document.querySelector("#welcome");
    welcome.style.display = "none";
    messages.dataset.chatState = "conversation";
    for (let index = 0; index < 40; index += 1) {
      const bubble = document.createElement("div");
      bubble.className = "msg msg-assistant";
      bubble.textContent = `测试消息 ${index + 1}`;
      messages.append(bubble);
    }
    const style = getComputedStyle(messages);
    return {
      state: messages.dataset.chatState,
      overflowY: style.overflowY,
      topGap: Math.round(parseFloat(getComputedStyle(messages, "::before").height)),
      canScroll: messages.scrollHeight > messages.clientHeight,
    };
  });

  expect(conversation).toEqual({
    state: "conversation",
    overflowY: "auto",
    topGap: 18,
    canScroll: true,
  });
});

async function readMessagesLayout(page) {
  return page.evaluate(() => {
    const messages = document.querySelector("#messages");
    const style = getComputedStyle(messages);
    return {
      state: messages.dataset.chatState,
      overflowY: style.overflowY,
      topGap: Math.round(parseFloat(getComputedStyle(messages, "::before").height)),
      leftInset: Math.round(parseFloat(style.paddingLeft)),
      rightInset: Math.round(parseFloat(style.paddingRight)),
    };
  });
}
