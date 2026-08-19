# **Technical Design Document: Prompt Enhancer VS Code Extension**

## **1\. Project Overview**

**Name:** Prompt Enhancer

**Goal:** A VS Code extension that intercepts user-selected text or chat inputs, processes them through an LLM to generate highly structured, context-rich prompts, and replaces the original text or outputs to the VS Code Chat interface.

**Core Features:**

* **Editor Integration:** Keyboard shortcut to replace highlighted text with an enhanced prompt.  
* **Chat Integration:** A Chat Participant (@enhance) to process requests directly in the VS Code Native Chat panel.  
* **Hybrid Architecture:**  
  * **BYOK (Bring Your Own Key):** Secure local storage of user API keys via VS Code's SecretStorage API.  
  * **Cloud Proxy (GCP):** A scalable backend using Firebase Functions v2 and Genkit to handle standardized prompt engineering logic and enterprise API key management.

## **2\. Architecture & Tech Stack**

### **Extension Core (Client)**

* **Language:** TypeScript (Strict Mode)  
* **Runtime:** Node.js (VS Code Extension Host)  
* **Build Tool:** tsup or esbuild  
* **Framework:** Native VS Code Extension API (@types/vscode version ^1.90.0 or higher to ensure Chat API support)

### **Backend & AI Infrastructure (GCP / Firebase)**

* **Compute:** Firebase Cloud Functions v2 (Powered by Cloud Run). High concurrency, long timeouts.  
* **AI Framework:** **Firebase Genkit**. Orchestration layer for LLMs using zod for strict type enforcement.  
* **Prompt Management:** Genkit's dotprompt format. Prompts will be stored as .prompt files (prompts-as-code).  
* **Secrets Management:** Google Cloud Secret Manager natively through Firebase (defineSecret).

## **3\. Data Contracts & API Interfaces (Crucial for AI Agent)**

To ensure the client and backend communicate perfectly, implement the following data structures.

**Request Payload (Client \-\> Firebase Function):**

{  
  "data": {  
    "rough\_text": "string",  
    "context": "string (optional \- e.g., current file language)",  
    "mode": "string (e.g., 'code', 'architecture', 'refactor')"  
  }  
}

**Response Payload (Firebase Function \-\> Client):**

{  
  "result": {  
    "enhanced\_prompt": "string"  
  }  
}

**Authentication Header:**

Requests from the extension to Firebase must include an Authorization: Bearer \<token\> or a custom header X-Extension-Auth if implementing a lightweight API key validation for the cloud proxy.

## **4\. Core Workflows & Logic**

### **Flow A: The Editor Shortcut (In-Line Enhancement)**

1. **Trigger:** User highlights rough text and presses Cmd+Shift+E.  
2. **Capture:** Extension reads vscode.window.activeTextEditor.selection.  
3. **Routing:**  
   * If local BYOK is configured via context.secrets, call the LLM provider directly using fetch.  
   * If using Cloud Proxy, send the JSON payload to the Firebase Function v2 endpoint.  
4. **Processing (Cloud Proxy):**  
   * Trigger a Genkit **Flow**.  
   * Flow uses an enhance.prompt template that structures the user's input.  
   * Genkit calls the LLM (e.g., Gemini 2.5 Flash or Claude via plugins) using zod to enforce the output schema.  
5. **Execution:** Use editBuilder.replace() to swap the rough text for the enhanced prompt.  
6. **State:** Use vscode.window.withProgress to show a loading spinner in the status bar.

### **Flow B: The Chat Participant (@enhance)**

1. **Trigger:** User types @enhance rewrite this requirement into a prompt.  
2. **Routing:** VS Code routes the request to the participant registered via vscode.chat.createChatParticipant.  
3. **Processing:** Routed to either the local BYOK or the Genkit backend.  
4. **Streaming Output:** Use vscode.ChatResponseStream.markdown() to stream the enhanced prompt back into the chat window.

### **Flow C: Bring Your Own Key (BYOK) Security (Client-Side)**

* **Storage:** Keys are strictly saved using vscode.ExtensionContext.secrets.store('llm\_api\_key', userKey). **NEVER** use workspace.configuration for keys.  
* **Retrieval:** context.secrets.get('llm\_api\_key').

## **5\. Backend Implementation Plan (Firebase Genkit)**

**Agent Instructions: Execute the following phases sequentially for the backend.**

### **Phase 1: Firebase & Genkit Setup**

1. Initialize Firebase Functions v2 (firebase init functions \-\> TypeScript).  
2. Install dependencies: npm install genkit @genkit-ai/googleai @genkit-ai/firebase zod.  
3. Configure Genkit in index.ts.

### **Phase 2: Secret Management & Configuration**

1. Import: import { defineSecret } from "firebase-functions/params";  
2. Define: const llmKey \= defineSecret('LLM\_API\_KEY');  
3. Pass secrets to the function: onCall({ secrets: \[llmKey\] }, ...)

### **Phase 3: Prompt Engineering (dotprompt)**

1. Create prompts/enhance.prompt.  
2. Define input and output schemas within the prompt using Genkit's syntax, ensuring it outputs a clean string or structured JSON containing the enhanced\_prompt.  
3. Write system instructions commanding the LLM to act as a senior staff prompt engineer.

### **Phase 4: Defining the Flow & Exposing Endpoint**

1. In index.ts, define a Genkit Flow using zod for input validation.  
2. Load the .prompt file and execute it.  
3. Expose via Firebase v2 onCall (which automatically handles CORS and extracts the data wrapper).

## **6\. Extension Implementation Plan (Client-Side)**

**Agent Instructions: Execute the following phases sequentially for the extension.**

### **Phase 1: Scaffold & Setup**

1. Initialize project using yo code (TypeScript).  
2. Update @types/vscode to the latest version to ensure Chat API availability.

### **Phase 2: Command & Shortcut Registration**

1. package.json: Contribute command promptEnhancer.enhanceSelection.  
2. package.json: Contribute keybinding (e.g., cmd+shift+e).  
3. Implement vscode.window.activeTextEditor selection reading and replacement logic.

### **Phase 3: Secret Management (BYOK)**

1. Create a SecretService class wrapping context.secrets.  
2. Add commands to the Command Palette: "Prompt Enhancer: Set API Key" and "Prompt Enhancer: Clear API Key" using vscode.window.showInputBox.

### **Phase 4: API Integration (Client to Backend)**

1. Create an APIClient class to handle both BYOK direct calls and GCP proxy calls.  
2. Implement the fetch call to the Firebase onCall endpoint (remember to wrap payload in { "data": { ... } }).

### **Phase 5: Chat Participant**

1. package.json: Contribute chatParticipants named @enhance.  
2. Register in extension.ts using vscode.chat.createChatParticipant('enhance', handler).  
3. Utilize ChatResponseStream to output the result.

## **7\. Testing & Branching Strategy**

* **Backend:** Use Genkit Developer UI (genkit start).  
* **Extension:** Use @vscode/test-electron.  
* **Branching (GitHub Flow):** main for production, feature/\* for active development.
