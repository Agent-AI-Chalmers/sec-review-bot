# Official sources used for defaults/profiles:
# Z.ai pricing overview:
# https://docs.z.ai/guides/overview/pricing
# Z.ai model docs:
# https://docs.z.ai/guides/llm/glm-5
# https://docs.z.ai/guides/llm/glm-4.5
# OpenAI API pricing:
# https://platform.openai.com/docs/pricing
# Anthropic pricing:
# https://www.anthropic.com/pricing
# Anthropic model announcement for Claude Sonnet 4.5 pricing parity:
# https://www.anthropic.com/news/claude-sonnet-4-5
# Kimi pricing:
# https://platform.kimi.com/
# https://platform.kimi.com/docs/pricing/chat
# Xiaomi MiMo pricing:
# Official MiMo home and Token Plan API confirm MiMo-V2.5-Pro availability
# and USD overseas plans. Per-token overseas model pricing is tiered by input
# length: <=256K and 256K-1M.
# https://mimo.mi.com/
# https://mimo.mi.com/api/v1/openTokenPlan/list
# DeepSeek pricing:
# https://api-docs.deepseek.com/quick_start/pricing/
# MiniMax pricing:
# https://platform.minimax.io/docs/guides/pricing-paygo
# Doubao pricing reference (official Volcengine docs; tiered by prompt length).
# Volcengine lists separate rates for input, output, and "cache hit" input tokens:
# https://www.volcengine.com/docs/84458/1585097
# Seed2.0 official model card reports representative USD prefill/decode prices:
# https://lf3-static.bytednsdoc.com/obj/eden-cn/lapzild-tss/ljhwZthlaukjlkulzlp/seed2/0214/Seed2.0%20Model%20Card.pdf
# Prices are per 1M tokens in the currency declared on each profile. For Seed2.0,
# the official model card reports representative USD prices because the product
# has interval pricing. Volcengine's pricing page separately lists cache-hit
# input as 20% of normal input for the relevant Seed2.0 tiers, so the USD cache
# rates below use that same ratio.
# Cached-input-storage is omitted here because local run artifacts only report
# cache-read tokens, not cache-write/storage.
# The three "free" profiles below are intentionally 0.0/0.0/0.0 because the
# official pricing page currently lists input, cached input, and output as Free.
PRICE_PROFILES: dict[str, dict[str, float | str]] = {
    "glm-5.1": {"input": 1.4, "cache": 0.26, "output": 4.4, "currency": "USD"},
    "glm-5": {"input": 1.0, "cache": 0.2, "output": 3.2, "currency": "USD"},
    "glm-5-turbo": {"input": 1.2, "cache": 0.24, "output": 4.0, "currency": "USD"},
    "glm-4.7": {"input": 0.6, "cache": 0.11, "output": 2.2, "currency": "USD"},
    "glm-4.7-flashx": {"input": 0.07, "cache": 0.01, "output": 0.4, "currency": "USD"},
    "glm-4.7-flash": {"input": 0.0, "cache": 0.0, "output": 0.0, "currency": "USD"},
    "glm-4.6": {"input": 0.6, "cache": 0.11, "output": 2.2, "currency": "USD"},
    "glm-4.5": {"input": 0.6, "cache": 0.11, "output": 2.2, "currency": "USD"},
    "glm-4.5-x": {"input": 2.2, "cache": 0.45, "output": 8.9, "currency": "USD"},
    "glm-4.5-air": {"input": 0.2, "cache": 0.03, "output": 1.1, "currency": "USD"},
    "glm-4.5-airx": {"input": 1.1, "cache": 0.22, "output": 4.5, "currency": "USD"},
    "glm-4.5-flash": {"input": 0.0, "cache": 0.0, "output": 0.0, "currency": "USD"},
    "glm-4-32b-0414-128k": {
        "input": 0.1,
        "cache": 0.0,
        "output": 0.1,
        "currency": "USD",
    },
    "glm-5v-turbo": {"input": 1.2, "cache": 0.24, "output": 4.0, "currency": "USD"},
    "glm-4.6v": {"input": 0.3, "cache": 0.05, "output": 0.9, "currency": "USD"},
    "glm-4.6v-flashx": {
        "input": 0.04,
        "cache": 0.004,
        "output": 0.4,
        "currency": "USD",
    },
    "glm-4.6v-flash": {"input": 0.0, "cache": 0.0, "output": 0.0, "currency": "USD"},
    "glm-4.5v": {"input": 0.6, "cache": 0.11, "output": 1.8, "currency": "USD"},
    "glm-ocr": {"input": 0.03, "cache": 0.0, "output": 0.03, "currency": "USD"},
    "gpt-5.2": {"input": 1.75, "cache": 0.175, "output": 14.0, "currency": "USD"},
    "gpt-5.1": {"input": 1.25, "cache": 0.125, "output": 10.0, "currency": "USD"},
    "gpt-5": {"input": 1.25, "cache": 0.125, "output": 10.0, "currency": "USD"},
    "gpt-5-mini": {"input": 0.25, "cache": 0.025, "output": 2.0, "currency": "USD"},
    "gpt-5-nano": {"input": 0.05, "cache": 0.005, "output": 0.4, "currency": "USD"},
    "gpt-4.1": {"input": 2.0, "cache": 0.5, "output": 8.0, "currency": "USD"},
    "gpt-4.1-mini": {"input": 0.4, "cache": 0.1, "output": 1.6, "currency": "USD"},
    "gpt-4.1-nano": {"input": 0.1, "cache": 0.025, "output": 0.4, "currency": "USD"},
    "gpt-4o": {"input": 2.5, "cache": 1.25, "output": 10.0, "currency": "USD"},
    "gpt-4o-mini": {"input": 0.15, "cache": 0.075, "output": 0.6, "currency": "USD"},
    "o3": {"input": 2.0, "cache": 0.5, "output": 8.0, "currency": "USD"},
    "o4-mini": {"input": 1.1, "cache": 0.275, "output": 4.4, "currency": "USD"},
    "claude-sonnet-4.5": {
        "input": 3.0,
        "cache": 0.3,
        "output": 15.0,
        "currency": "USD",
    },
    "claude-sonnet-4": {"input": 3.0, "cache": 0.3, "output": 15.0, "currency": "USD"},
    "claude-sonnet-3.7": {
        "input": 3.0,
        "cache": 0.3,
        "output": 15.0,
        "currency": "USD",
    },
    "claude-haiku-4.5": {"input": 1.0, "cache": 0.1, "output": 5.0, "currency": "USD"},
    "claude-haiku-3.5": {"input": 0.8, "cache": 0.08, "output": 4.0, "currency": "USD"},
    "kimi-k2.6": {"input": 6.5, "cache": 1.1, "output": 27.0, "currency": "CNY"},
    "kimi-k2.5": {"input": 4.0, "cache": 0.7, "output": 21.0, "currency": "CNY"},
    "kimi-k2": {"input": 4.0, "cache": 1.0, "output": 16.0, "currency": "CNY"},
    "mimo-v2.5-pro": {"input": 1.0, "cache": 0.2, "output": 3.0, "currency": "USD"},
    "mimo-v2.5-pro-0-256k": {
        "input": 1.0,
        "cache": 0.2,
        "output": 3.0,
        "currency": "USD",
    },
    "mimo-v2.5-pro-256k-1m": {
        "input": 2.0,
        "cache": 0.4,
        "output": 6.0,
        "currency": "USD",
    },
    "minimax-m2.7": {"input": 0.3, "cache": 0.06, "output": 1.2, "currency": "USD"},
    "minimax-m2.7-highspeed": {
        "input": 0.6,
        "cache": 0.06,
        "output": 2.4,
        "currency": "USD",
    },
    "minimax-m2.5": {"input": 0.3, "cache": 0.03, "output": 1.2, "currency": "USD"},
    "minimax-m2.5-highspeed": {
        "input": 0.6,
        "cache": 0.03,
        "output": 2.4,
        "currency": "USD",
    },
    "m2-her": {"input": 0.3, "cache": 0.0, "output": 1.2, "currency": "USD"},
    "deepseek-v4-flash": {
        "input": 0.14,
        "cache": 0.0028,
        "output": 0.28,
        "currency": "USD",
    },
    "deepseek-v4-pro": {
        "input": 1.74,
        "cache": 0.0145,
        "output": 3.48,
        "currency": "USD",
    },
    "doubao-seed-2.0-code-0-32k": {
        "input": 0.47,
        "cache": 0.094,
        "output": 2.37,
        "currency": "USD",
    },
    "doubao-seed-2.0-code-32-128k": {
        "input": 0.47,
        "cache": 0.094,
        "output": 2.37,
        "currency": "USD",
    },
    "doubao-seed-2.0-code-128-256k": {
        "input": 0.47,
        "cache": 0.094,
        "output": 2.37,
        "currency": "USD",
    },
    "doubao-seed-2.0-pro-0-32k": {
        "input": 0.47,
        "cache": 0.094,
        "output": 2.37,
        "currency": "USD",
    },
    "doubao-seed-2.0-pro-32-128k": {
        "input": 0.47,
        "cache": 0.094,
        "output": 2.37,
        "currency": "USD",
    },
    "doubao-seed-2.0-pro-128-256k": {
        "input": 0.47,
        "cache": 0.094,
        "output": 2.37,
        "currency": "USD",
    },
    "doubao-seed-2.0-lite-0-32k": {
        "input": 0.09,
        "cache": 0.018,
        "output": 0.53,
        "currency": "USD",
    },
    "doubao-seed-2.0-lite-32-128k": {
        "input": 0.09,
        "cache": 0.018,
        "output": 0.53,
        "currency": "USD",
    },
    "doubao-seed-2.0-lite-128-256k": {
        "input": 0.09,
        "cache": 0.018,
        "output": 0.53,
        "currency": "USD",
    },
}
DEFAULT_PRICE_PROFILE = "glm-5.1"

MODEL_PROFILE_ALIASES: dict[str, str] = {
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
    "claude-sonnet-4-20250514": "claude-sonnet-4",
    "claude-3-7-sonnet-20250219": "claude-sonnet-3.7",
    "claude-3-5-haiku-latest": "claude-haiku-3.5",
    "claude-haiku-4-5": "claude-haiku-4.5",
    "deepseek-chat": "deepseek-v4-flash",
    "deepseek-reasoner": "deepseek-v4-flash",
    "minimax-latest": "minimax-m2.7",
}
