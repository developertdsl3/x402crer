import dotenv from "dotenv";
import path from "path";
import 'dotenv/config';
// OR
// import dotenv from 'dotenv';
// dotenv.config();


// Load .env from project root
const projectRoot = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(projectRoot, ".env"), override: true });

import express from "express";
import cors from "cors";
import { createHash } from "node:crypto";
import { paymentMiddleware } from "x402-express";
import { settleResponseFromHeader } from "x402/types";
import { exact } from "x402/schemes";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { startChatInterface } from "./chat";

/**
 * Unified API Server
 *
 * This server demonstrates a crypto price alert system that combines:
 * - Natural language processing (via Gemini AI)
 * - x402 payment protocol for micropayments
 * - Chainlink CRE (Chainlink Runtime Environment) for on-chain operations
 *
 * Architecture:
 * - /chat: Natural language interface for creating alerts (no payment required)
 *   - Uses Gemini AI to extract alert parameters from user messages
 *   - Validates that only supported assets (BTC, ETH, LINK) are requested
 *   - Returns alert payload and instructions for the agent to pay via Agentic Wallet (POST /alerts with x402)
 *
 * - /alerts: Direct alert creation endpoint (requires x402 payment)
 *   - Protected by x402 payment middleware ($0.01 USDC)
 *   - Creates alert with deterministic ID (SHA256 hash)
 *   - Outputs CRE workflow payload for on-chain storage
 *
 * x402 Payment Flow:
 * 1. Client sends request without payment → Server responds with 402 Payment Required
 * 2. Client processes challenge, creates payment authorization
 * 3. Client retries with x-payment header → Server validates payment
 * 4. Server creates alert and responds with 200 + settlement transaction hash
 *
 * @see https://x402.org/ - x402 payment protocol documentation
 * @see https://docs.chain.link/cre - Chainlink CRE documentation
 */

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// Configuration & Validation
// ============================================================================

/**
 * Validate required environment variables on startup
 */
if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY environment variable is required");
}
if (!process.env.X402_RECEIVER_ADDRESS) {
  throw new Error("X402_RECEIVER_ADDRESS environment variable is required");
}

/**
 * Gemini client for natural language processing
 * Uses Google's native Generative AI SDK
 */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
// Try gemini-2.5-flash which might have better availability/rate limits
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });


/**
 * Server port (default: 3000)
 */
const PORT = Number(process.env.PORT ?? 3000);

/**
 * x402 payment recipient address
 */
const payToAddress = process.env.X402_RECEIVER_ADDRESS as `0x${string}`;

/**
 * x402 facilitator URL
 */
const facilitatorUrl = (process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator") as `${string}://${string}`;

/**
 * Public base URL of this server (for agent to call /alerts with x402).
 * Use SERVER_BASE_URL in .env for production (e.g. https://your-domain.com).
 */
const SERVER_BASE_URL = process.env.SERVER_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Optional deployed CRE HTTP trigger endpoint for fully automated flow.
 *
 * When set, POST /alerts will automatically forward the created alert payload
 * to this URL so no manual CRE CLI paste step is required.
 */
const CRE_HTTP_TRIGGER_URL = process.env.CRE_HTTP_TRIGGER_URL;
const CRE_HTTP_TRIGGER_AUTH_BEARER = process.env.CRE_HTTP_TRIGGER_AUTH_BEARER;
const CRE_HTTP_TRIGGER_WORKFLOW_ID = process.env.CRE_HTTP_TRIGGER_WORKFLOW_ID;

/**
 * Supported cryptocurrency assets for price alerts
 * Only BTC, ETH, and LINK are supported in this demo
 */
const ALLOWED_ASSETS = ["BTC", "ETH", "LINK"] as const;

/**
 * Supported price alert conditions
 * - gt: greater than
 * - lt: less than
 * - gte: greater than or equal
 * - lte: less than or equal
 */
const ALLOWED_CONDITIONS = ["gt", "lt", "gte", "lte"] as const;

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Unified API Server");
console.log(`   Port: ${PORT} | Payment: $0.01 USDC`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

// ============================================================================
// Request Logging Middleware
// ============================================================================

/**
 * Request Logging Middleware
 *
 * This middleware intercepts all requests and responses to log the x402 payment handshake.
 * It helps developers understand the payment flow by showing each step of the exchange.
 *
 * The x402 handshake consists of 4 steps:
 * 1. Server → Client: 402 Payment Required (challenge)
 * 2. Client processes challenge and creates payment authorization
 * 3. Client → Server: Retry with payment authorization header
 * 4. Server → Client: Payment settled (transaction hash)
 *
 * @see https://x402.org/ - x402 payment protocol specification
 */
app.use((req, res, next) => {
  const paymentHeader = req.headers["x-payment"] as string | undefined;
  const hasPayment = !!paymentHeader;

  // Intercept response to log x402 handshake details
  const originalSend = res.send.bind(res);
  res.send = (body: any) => {
    // x402 Handshake Step 1: Server sends 402 Payment Required (challenge)
    // This happens when client makes initial request without payment header
    if (res.statusCode === 402 && req.path === "/alerts") {
      console.log("\n  [x402 Handshake]");
      console.log("    Step 1: Server → Client: 402 Payment Required");
      console.log("    Step 2: Client will process challenge and retry with payment");
    }

    // x402 Handshake Step 3: Server receives payment and validates
    // This happens when client retries request with x-payment header
    if (hasPayment && req.path === "/alerts") {
      try {
        const decoded = exact.evm.decodePayment(paymentHeader);
        if ("authorization" in decoded.payload) {
          const auth = decoded.payload.authorization;
          // USDC has 6 decimals, so divide by 10^6 to get USD amount
          const amountUsd = Number(auth.value) / 10 ** 6;
          console.log("\n  [x402 Handshake]");
          console.log("    Step 3: Client → Server: Payment authorization received");
          console.log(`    - Amount: $${amountUsd.toFixed(2)} USDC`);
          console.log(`    - Payer: ${auth.from}`);
          console.log("    - Validating payment...");
        }
      } catch (e) {
        // Failed to decode payment header (shouldn't happen if payment is valid)
      }
    }

    // x402 Handshake Step 4: Server responds with settlement
    // The x-payment-response header contains the on-chain transaction hash
    const paymentResponse = res.getHeader("x-payment-response") as string | undefined;
    if (paymentResponse && res.statusCode === 200) {
      try {
        const settlement = settleResponseFromHeader(paymentResponse);
        if (settlement.transaction) {
          console.log("    Step 4: Server → Client: Payment settled");
          console.log(`    - Transaction: ${settlement.transaction}`);
        }
      } catch (e) {
        // Failed to decode settlement response
      }
    }

    return originalSend(body);
  };

  next();
});

// ============================================================================
// x402 Payment Middleware
// ============================================================================

/**
 * x402 Payment Middleware Configuration
 *
 * This middleware handles the x402 payment protocol:
 * - Intercepts requests to protected endpoints (e.g., POST /alerts)
 * - Responds with 402 Payment Required if no valid payment header
 * - Validates payment headers and processes settlements
 * - Adds x-payment-response header with settlement details
 */
app.use(
  paymentMiddleware(
    payToAddress,
    {
      "POST /alerts": {
        price: "$0.01",
        network: "base-sepolia",
        config: {
          description: "Create a crypto price alert",
        },
      },
    },
    { url: facilitatorUrl }
  )
);

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Supported price alert conditions
 *
 * - gt: greater than (e.g., "alert when price > $50000")
 * - lt: less than (e.g., "alert when price < $40000")
 * - gte: greater than or equal (e.g., "alert when price >= $50000")
 * - lte: less than or equal (e.g., "alert when price <= $40000")
 */
type AlertCondition = "gt" | "lt" | "gte" | "lte";

/**
 * Request body for creating a price alert via POST /alerts
 *
 * This is the direct API format. The /chat endpoint uses Gemini to
 * extract these parameters from natural language.
 */
interface AlertRequestBody {
  /** Cryptocurrency asset symbol (must be one of: BTC, ETH, LINK) */
  asset: string;
  /** Price condition (gt, lt, gte, lte) */
  condition: AlertCondition;
  /** Target price in USD */
  targetPriceUsd: number;
}

/**
 * Stored alert with generated ID and metadata
 *
 * The alert ID is a deterministic SHA256 hash of the alert data,
 * ensuring the same parameters always produce the same ID.
 */
interface StoredAlert extends AlertRequestBody {
  /** Deterministic SHA256 hash of alert data */
  id: string;
  /** Wallet address that paid for the alert (extracted from x402 payment) */
  payer: string;
  /** UNIX timestamp in seconds when the alert was created */
  createdAt: number;
}

interface CreTriggerResult {
  enabled: boolean;
  attempted: boolean;
  success: boolean;
  statusCode?: number;
  error?: string;
}

async function triggerCreHttpWorkflow(payload: {
  id: string;
  asset: string;
  condition: AlertCondition;
  targetPriceUsd: number;
  createdAt: number;
}): Promise<CreTriggerResult> {
  if (!CRE_HTTP_TRIGGER_URL) {
    return { enabled: false, attempted: false, success: false };
  }

  try {
    const targetUrl = new URL(CRE_HTTP_TRIGGER_URL);
    if (CRE_HTTP_TRIGGER_WORKFLOW_ID && !targetUrl.searchParams.get("workflowID")) {
      targetUrl.searchParams.set("workflowID", CRE_HTTP_TRIGGER_WORKFLOW_ID);
    }

    // Local cre-http-trigger expects {"input": {...}}.
    // For generic webhooks, raw payload may be preferred; keep local mode opt-in via workflow ID.
    const requestBody = CRE_HTTP_TRIGGER_WORKFLOW_ID ? { input: payload } : payload;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (CRE_HTTP_TRIGGER_AUTH_BEARER) {
      headers.Authorization = `Bearer ${CRE_HTTP_TRIGGER_AUTH_BEARER}`;
    }

    const response = await fetch(targetUrl.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        enabled: true,
        attempted: true,
        success: false,
        statusCode: response.status,
        error: body || `CRE trigger failed with status ${response.status}`,
      };
    }

    return {
      enabled: true,
      attempted: true,
      success: true,
      statusCode: response.status,
    };
  } catch (error: any) {
    return {
      enabled: true,
      attempted: true,
      success: false,
      error: error?.message ?? "Unknown CRE trigger error",
    };
  }
}

// ============================================================================
// API Endpoints
// ============================================================================

/**
 * POST /chat
 * Natural language interface for creating price alerts
 *
 * This endpoint provides a conversational interface for creating price alerts.
 * It uses Gemini AI to understand user intent and extract alert parameters.
 *
 * Process:
 * 1. User sends natural language message (e.g., "Alert me when BTC is greater than 60000")
 * 2. Gemini AI analyzes the message and extracts: asset, condition, targetPriceUsd
 * 3. If unsupported asset is mentioned, Gemini responds with helpful text
 * 4. If supported asset, Gemini calls create_price_alert function
 * 5. Server validates extracted parameters
 * 6. Server creates paid alert via internal /alerts endpoint (x402 payment)
 * 7. Returns alert details and payment transaction hash
 *
 * Supported Assets: BTC, ETH, LINK only
 * Supported Conditions: gt (greater than), lt (less than), gte (>=), lte (<=)
 *
 * @route POST /chat
 * @body {string} message - Natural language message requesting a price alert
 * @returns {Object} Response with reply, alert details, and transaction hash
 *
 * @example
 * Request: { "message": "Create an alert when BTC is greater than 50000" }
 * Response: {
 *   "reply": "Price alert created: BTC gt $50000",
 *   "alert": { "id": "...", "asset": "BTC", ... },
 *   "transactionHash": "0x..."
 * }
 */
app.post("/chat", async (req, res) => {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("POST /chat");
  console.log(`  Message: "${req.body.message}"`);

  const { message } = req.body;

  if (!message || typeof message !== "string") {
    console.log("  [ERROR] Invalid message");
    return res.status(400).json({ error: "Missing or invalid message" });
  }

  try {
    /**
     * Step 1: Extract alert parameters using Gemini AI
     *
     * We use Gemini's function calling capability to extract structured data
     * from natural language. The system message instructs Gemini to:
     * - Only create alerts for supported assets (BTC, ETH, LINK)
     * - Respond with helpful text if unsupported assets are requested
     * - Call the create_price_alert function only for valid requests
     */
    console.log("  [1] Extracting alert parameters with Gemini...");
    
    // Convert to Gemini's function calling format
    const tools: any = [
      {
        functionDeclarations: [
          {
            name: "create_price_alert",
            description: `Create a price alert. ONLY use this function for supported assets: ${ALLOWED_ASSETS.join(
              ", "
            )}. If the user requests an unsupported asset, respond with text instead.`,
            parameters: {
              type: "object",
              properties: {
                asset: {
                  type: "string",
                  enum: [...ALLOWED_ASSETS],
                  description: `The cryptocurrency asset to monitor. MUST be one of: ${ALLOWED_ASSETS.join(", ")}`,
                },
                condition: {
                  type: "string",
                  enum: [...ALLOWED_CONDITIONS],
                  description:
                    "The price condition: gt (greater than), lt (less than), gte (greater than or equal), lte (less than or equal)",
                },
                targetPriceUsd: {
                  type: "number",
                  description: "The target price in USD",
                },
              },
              required: ["asset", "condition", "targetPriceUsd"],
            },
          },
        ],
      },
    ];

    const systemInstruction = `You are a helpful assistant that creates crypto price alerts. 

IMPORTANT RULES:
- You can ONLY create alerts for these supported assets: ${ALLOWED_ASSETS.join(", ")}
- If a user requests an alert for ANY other asset (like SOL, DOGE, ADA, XRP, etc.), you MUST respond with a text message explaining that only ${ALLOWED_ASSETS.join(
      ", "
    )} are supported
- DO NOT call the create_price_alert function if the user requests an unsupported asset
- Only call the create_price_alert function when the user requests an alert for one of the supported assets: ${ALLOWED_ASSETS.join(
      ", "
    )}`;

    // Retry logic for rate limits with exponential backoff
    // Note: Gemini API free tier has strict rate limits (typically 15 requests/minute)
    // Rate limits can be IP-based, not just API key-based
    let result;
    let lastError;
    const maxRetries = 1; // Only 1 retry to avoid making things worse
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`  [ATTEMPT] Retry ${attempt}/${maxRetries}...`);
        }
        // Use generateContent - system instruction must be passed as a parameter, not in contents
        // Gemini only accepts "user" and "model" roles in contents array
        result = await model.generateContent({
          contents: [
            { role: "user", parts: [{ text: message }] }
          ],
          systemInstruction: systemInstruction, // Pass as separate parameter
          tools: tools as any,
        });
        break; // Success, exit retry loop
      } catch (error: any) {
        lastError = error;
        
        // Log detailed error information for debugging
        console.log(`  [DEBUG] Error details:`);
        console.log(`    Status: ${error.status || error.statusCode || 'N/A'}`);
        console.log(`    Message: ${error.message || 'N/A'}`);
        if (error.response) {
          console.log(`    Response status: ${error.response.status}`);
          if (error.response.data) {
            console.log(`    Response data: ${JSON.stringify(error.response.data, null, 2)}`);
          }
        }
        
        // Check if it's a rate limit error (429)
        if (error.status === 429 || error.statusCode === 429 || error.message?.includes("429") || error.message?.includes("rate limit") || error.message?.includes("TooManyRequests") || error.message?.includes("Quota exceeded")) {
          // Extract retry delay from error message if available
          let waitTime = 60000; // Default 60 seconds
          const retryMatch = error.message?.match(/Please retry in ([\d.]+)s/);
          if (retryMatch) {
            waitTime = Math.ceil(parseFloat(retryMatch[1])) * 1000;
            console.log(`  [INFO] API suggests waiting ${waitTime/1000}s`);
          }
          
          // Free tier limit is 5 requests/minute per model
          if (error.message?.includes("limit: 5")) {
            console.log(`  [INFO] Free tier limit: 5 requests/minute per model`);
          }
          
          if (attempt < maxRetries) {
            console.log(`  [RATE LIMIT] Waiting ${waitTime/1000}s for rate limit to reset (attempt ${attempt + 1}/${maxRetries + 1})...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          } else {
            // After max retries, provide helpful message
            console.log("  [INFO] Rate limit persists after retries.");
            console.log("  [INFO] Gemini API free tier allows 5 requests/minute per model.");
            console.log("  [INFO] Please wait before trying again.");
            throw error;
          }
        }
        throw error; // Re-throw if not rate limit or max retries reached
      }
    }
    
    if (!result) {
      throw lastError || new Error("Failed to get response from Gemini");
    }
    
    const response = result.response;
    
    // Check if there's a function call
    const functionCalls = response.functionCalls() || [];
    const textResponse = response.text();

    if (!response) {
      console.log("  [ERROR] No response from Gemini");
      return res.status(500).json({ error: "No response from Gemini" });
    }

    /**
     * Handle text response from Gemini
     *
     * Gemini may respond with text instead of calling the function when:
     * - User requests an unsupported asset
     * - User's message is unclear or not a valid alert request
     * - User asks a question or makes a general inquiry
     */
    if (functionCalls.length === 0 && textResponse) {
      console.log(`  [REPLY] "${textResponse}"`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      return res.json({ reply: textResponse });
    }

    /**
     * Handle function call from Gemini
     *
     * When Gemini calls the create_price_alert function, we:
     * 1. Parse the function arguments (asset, condition, targetPriceUsd)
     * 2. Validate the parameters match our constraints
     * 3. Create the alert via x402 payment
     */
    if (functionCalls.length > 0 && functionCalls[0].name === "create_price_alert") {
      /**
       * Parse function arguments from Gemini's function call
       *
       * Gemini returns function arguments as an object.
       * The arguments should contain: asset, condition, and targetPriceUsd.
       */
      const args = functionCalls[0].args as {
        asset: string;
        condition: string;
        targetPriceUsd: number;
      };

      /**
       * Validate extracted parameters
       *
       * Even though Gemini's function definition includes enum constraints,
       * we perform additional validation as a security measure.
       */
      if (!ALLOWED_ASSETS.includes(args.asset as typeof ALLOWED_ASSETS[number])) {
        return res.status(400).json({
          error: `Asset "${args.asset}" is not supported. Only ${ALLOWED_ASSETS.join(", ")} are allowed.`,
        });
      }
      if (!ALLOWED_CONDITIONS.includes(args.condition as typeof ALLOWED_CONDITIONS[number])) {
        return res.status(400).json({
          error: `Invalid condition "${args.condition}". Must be one of: ${ALLOWED_CONDITIONS.join(", ")}`,
        });
      }
      if (typeof args.targetPriceUsd !== "number" || args.targetPriceUsd <= 0) {
        return res.status(400).json({
          error: "targetPriceUsd must be a positive number",
        });
      }

      console.log(`  [2] Parameters: ${args.asset} ${args.condition} $${args.targetPriceUsd}`);

      /**
       * Agent pays via Agentic Wallet (x402).
       *
       * We do NOT call createPaidPriceAlert() (server key). We return the alert
       * payload and the /alerts URL so the agent can use pay-for-service (Agentic
       * Wallet) to POST with x402 payment.
       */
      const alertPayload = {
        asset: args.asset as typeof ALLOWED_ASSETS[number],
        condition: args.condition as typeof ALLOWED_CONDITIONS[number],
        targetPriceUsd: args.targetPriceUsd,
      };
      // Build URL safely so trailing slash in SERVER_BASE_URL doesn't create //alerts
      const alertsUrl = new URL("/alerts", SERVER_BASE_URL).toString();

      console.log("  [3] Returning payload for agent to pay via Agentic Wallet (POST /alerts with x402)");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

      return res.json({
        reply: `To create this alert, use your Agentic Wallet to pay for the API. POST the payload below to ${alertsUrl} with x402 payment ($0.01 USDC). Use the pay-for-service skill.`,
        paymentByAgent: true,
        alertsUrl,
        alertPayload,
        paymentAmountUsd: 0.01,
        instructions: "Use Agentic Wallet pay-for-service skill to POST alertPayload to alertsUrl with x402 payment.",
      });
    } else {
      /**
       * Fallback: Text response from Gemini
       *
       * This handles cases where Gemini returns a response but it doesn't
       * match our expected patterns (no function call, no content, etc.)
       */
      const textReply = textResponse
        ? textResponse
        : "I can help you create price alerts for BTC, ETH, or LINK. Try saying something like 'Create an alert when BTC is greater than 50000'.";
      console.log(`  [REPLY] "${textReply}"`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      return res.json({ reply: textReply });
    }
  } catch (error: any) {
    /**
     * Error Handling
     *
     * Handles various error scenarios:
     * - 429 Rate Limit: Too many requests to Gemini API
     * - 400 Bad Request: Invalid request format or parameters
     * - 500 Server Error: Gemini API errors or other server issues
     */

    // Handle rate limit errors (429)
    if (error.status === 429 || error.statusCode === 429) {
      console.log("  [ERROR] Gemini API rate limit exceeded (429)");
      console.log("  [INFO] Please wait before making another request");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      return res.status(429).json({
        error: "Rate limit exceeded",
        message: "Too many requests to Gemini API. Please try again later.",
        details: error.message || "Rate limit exceeded",
      });
    }

    // Handle other API errors
    const statusCode = error.status || error.statusCode || 500;
    const errorMessage = error.message || "Unknown error";

    console.log(`  [ERROR] Gemini API error: ${statusCode} - ${errorMessage}`);

    // Log detailed error information for debugging
    if (error.response) {
      console.log(`  [ERROR] Response status: ${error.response.status}`);
      if (error.response.data) {
        console.log(`  [ERROR] Response body: ${JSON.stringify(error.response.data, null, 2)}`);
      }
    }

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      error: "An error occurred while processing your request",
      details: errorMessage,
      statusCode: statusCode,
    });
  }
});

/**
 * POST /alerts
 * Create a new price alert (requires x402 payment)
 *
 * This endpoint demonstrates the x402 payment flow:
 * 1. Client sends request → Server responds with 402 if no payment
 * 2. Client retries with x-payment header → Server validates payment
 * 3. Server creates alert and responds with 200 + settlement details
 * 4. Calls the HTTP Trigger of the CRE Workflow
 *    - Automated calls to the CRE Workflow require a deployed workflow, and is not implemented in this demo.
 *    - This demo assumes you will be using local simulation.
 *
 * @route POST /alerts
 * @requires x402 payment ($0.01 USD in USDC on base-sepolia)
 * @body {string} asset - Cryptocurrency symbol (BTC, ETH, LINK)
 * @body {string} condition - Price condition (gt, lt, gte, lte)
 * @body {number} targetPriceUsd - Target price in USD
 * @returns {Object} Created alert with ID and metadata
 */
app.post("/alerts", async (req, res) => {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("POST /alerts");

  const body = req.body as Partial<AlertRequestBody>;

  /**
   * Step 1: Validate request body
   *
   * Ensures all required fields are present and properly typed.
   * This validation happens after x402 payment is verified by middleware.
   */
  if (!body.asset || !body.condition || typeof body.targetPriceUsd !== "number") {
    console.log("  [ERROR] Missing required fields");
    return res.status(400).json({
      error: "Missing required fields",
      required: ["asset", "condition", "targetPriceUsd"],
    });
  }

  /**
   * Step 2: Payment verification
   *
   * The x402 payment middleware has already validated the payment by this point.
   * If the request reaches here, the payment is valid and has been settled.
   * We extract the payer address from the payment header for record-keeping.
   */
  console.log("  [1] x402 payment verified");

  // Extract payer address from x402 payment header
  let payer = "unknown";
  const paymentHeader = req.headers["x-payment"] as string | undefined;
  if (paymentHeader) {
    try {
      const decoded = exact.evm.decodePayment(paymentHeader);
      if ("authorization" in decoded.payload) {
        payer = decoded.payload.authorization.from;
      }
    } catch (e) {
      // Could not extract payer (shouldn't happen if payment was verified)
    }
  }

  /**
   * Step 3: Create alert with deterministic ID
   *
   * The alert ID is generated using SHA256 hash of the alert data.
   * This ensures the same alert parameters always produce the same ID,
   * making it idempotent and preventing duplicate alerts.
   */
  const alertData = {
    payer,
    asset: body.asset,
    condition: body.condition,
    targetPriceUsd: body.targetPriceUsd,
    createdAt: Math.floor(Date.now() / 1000), // UNIX timestamp in seconds
  };

  // Generate deterministic alert ID (SHA256 hash of alert data)
  const id = createHash("sha256").update(JSON.stringify(alertData)).digest("hex");

  const alert: StoredAlert = {
    id,
    ...alertData,
  };

  console.log(`  [2] Alert created: ${alert.id} (${alert.asset} ${alert.condition} $${alert.targetPriceUsd})`);

  /**
   * Step 4: Prepare CRE workflow payload
   *
   * This payload is intended to be sent to the Chainlink CRE HTTP trigger
   * to write the alert on-chain to the RuleRegistry contract.
   *
   * For demo purposes, the payload is logged to console for manual execution
   * via the CRE CLI. In production, this would be sent automatically.
   *
   * @see https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/
   */
  const workflowPayload = {
    id: alert.id,
    asset: alert.asset,
    condition: alert.condition,
    targetPriceUsd: alert.targetPriceUsd,
    createdAt: alert.createdAt,
  };

  console.log("  [3] CRE payload ready:\n");
  console.log(JSON.stringify(workflowPayload));
  const creTrigger = await triggerCreHttpWorkflow(workflowPayload);
  if (creTrigger.enabled) {
    if (creTrigger.success) {
      console.log("  [4] CRE HTTP trigger sent successfully");
    } else {
      console.log(`  [4] CRE HTTP trigger failed: ${creTrigger.error ?? "Unknown error"}`);
    }
  } else {
    console.log("  [4] CRE HTTP trigger not configured (set CRE_HTTP_TRIGGER_URL for full automation)");
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  res.status(201).json({ alert, creTrigger });
});

// ============================================================================
// Server Startup
// ============================================================================

app.listen(PORT, () => {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Server ready");
  console.log(`   http://localhost:${PORT}`);
  console.log("   POST /chat   (natural language, no payment)");
  console.log("   POST /alerts (requires x402 payment)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Enable interactive chat if --chat flag is passed or ENABLE_CHAT env var is set
  const enableChat = process.argv.includes("--chat") || process.env.ENABLE_CHAT === "true";
  if (enableChat) {
    startChatInterface(PORT);
  }
});
