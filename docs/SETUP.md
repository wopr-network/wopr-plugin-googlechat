# Google Chat Plugin Setup Guide

## Prerequisites

- Google Cloud project with billing enabled
- Google Workspace account (or Google account for testing)
- A domain with HTTPS support (or ngrok for development)

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Note your **Project Number** (visible in project settings)

## Step 2: Enable Google Chat API

1. In Google Cloud Console, go to **APIs & Services > Library**
2. Search for "Google Chat API" and enable it
3. Go to **APIs & Services > Google Chat API > Configuration**

## Step 3: Create a Service Account

1. Go to **IAM & Admin > Service Accounts**
2. Click **Create Service Account**
3. Name: `wopr-chat-bot` (or similar)
4. Grant no roles (Chat Bot scope is self-grantable)
5. Click **Create and Continue > Done**
6. Click on the service account, go to **Keys > Add Key > Create new key**
7. Choose **JSON** format — save the downloaded file securely

## Step 4: Configure the Google Chat App

1. Go to **APIs & Services > Google Chat API > Configuration**
2. Fill in:
   - **App name**: Your bot name (e.g., "WOPR Bot")
   - **Avatar URL**: Optional icon
   - **Description**: Short description
3. Under **Connection settings**:
   - Select **HTTP endpoint URL**
   - Enter: `https://your-domain.com:8443/googlechat/events`
4. Under **Authentication**: Select **Service account** and enter the service account email

## Step 5: Configure Slash Commands (Optional)

1. In **APIs & Services > Google Chat API > Configuration > Slash commands**
2. Click **Add slash command**
3. For each command:
   - **Command ID**: Numeric ID (e.g., 1)
   - **Name**: `/help`
   - **Description**: What the command does
4. Commands are routed through WOPR inject automatically

## Step 6: Configure WOPR Plugin

Add to your WOPR config file:

```json
{
  "channels": {
    "googlechat": {
      "enabled": true,
      "serviceAccountKeyPath": "/path/to/service-account.json",
      "projectNumber": "YOUR_PROJECT_NUMBER",
      "webhookPort": 8443,
      "webhookPath": "/googlechat/events",
      "dmPolicy": "open",
      "spacePolicy": "open",
      "useCards": false
    }
  }
}
```

Or use environment variables:
```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export GOOGLE_PROJECT_NUMBER=123456789
```

## Step 7: Install and Start

```bash
wopr plugin install @wopr-network/wopr-plugin-googlechat
wopr daemon restart
```

## Development with ngrok

For local development, use ngrok to expose your local port:

```bash
ngrok http 8443
```

Use the ngrok HTTPS URL in the Google Chat API configuration.

## Workspace Admin Deployment

For Google Workspace organizations, the admin must publish the app:

1. Go to Google Admin Console > Apps > Google Workspace > Marketplace apps
2. Or configure the app as internal-only under Google Chat API settings

## Troubleshooting

- **Bot not responding**: Check webhook URL is accessible from Google's servers
- **Auth errors**: Verify service account JSON path and chat.bot scope
- **Retry loops**: Ensure your endpoint returns HTTP 200 (plugin does this by default)
