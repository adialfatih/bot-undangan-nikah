## BOT untuk menangani acara

bisa di gunkana 


fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <OPENROUTER_API_KEY>",
    "HTTP-Referer": "<YOUR_SITE_URL>", // Optional. Site URL for rankings on openrouter.ai.
    "X-Title": "<YOUR_SITE_NAME>", // Optional. Site title for rankings on openrouter.ai.
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    "model": "z-ai/glm-4.5-air:free",
    "messages": [
      {
        "role": "user",
        "content": "What is the meaning of life?"
      }
    ]
  })

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


fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <OPENROUTER_API_KEY>",
    "HTTP-Referer": "<YOUR_SITE_URL>", // Optional. Site URL for rankings on openrouter.ai.
    "X-Title": "<YOUR_SITE_NAME>", // Optional. Site title for rankings on openrouter.ai.
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    "model": "deepseek/deepseek-r1-0528:free",
    "messages": [
      {
        "role": "user",
        "content": "What is the meaning of life?"
      }
    ]
  })
});