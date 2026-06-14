const { Resend } = require('resend');

let resend = null;

// Initialize Resend if API key is provided
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
} else {
}

// Set RESEND_FROM_EMAIL to your verified domain email (e.g., 'IDDI <hello@yourdomain.com>')
// Fallback to Resend's sandbox email (only delivers to account owner — NOT production-ready)
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'IDDI <onboarding@resend.dev>';
const IS_SANDBOX = !process.env.RESEND_FROM_EMAIL || FROM_EMAIL.includes('resend.dev');
if (IS_SANDBOX) {
  console.warn('[Email] WARNING: Using Resend sandbox mode. Emails only deliver to account owner. Set RESEND_FROM_EMAIL to a verified domain.');
}
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://iddisolutions.net';

// Email Templates
const templates = {
  // Welcome email - sent immediately after registration
  welcome: (userName) => ({
    subject: 'Welcome to IDDI - Let\'s Get Your Vending Business Running Smarter',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
          .button { display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
          .feature { margin: 15px 0; padding-left: 25px; position: relative; }
          .feature::before { content: "\\2713"; position: absolute; left: 0; color: #10B981; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Welcome to IDDI!</h1>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>Thanks for joining IDDI! You've just taken the first step toward smarter vending machine management.</p>

            <h3>Here's what you can do right now:</h3>
            <div class="feature">Add your first vending machine</div>
            <div class="feature">Set up your product inventory</div>
            <div class="feature">Generate QR codes for customer engagement</div>
            <div class="feature">Start tracking product performance</div>

            <center>
              <a href="${FRONTEND_URL}/vendor/machines" class="button">Add Your First Machine</a>
            </center>

            <p>We're here to help you boost profits and save time. Reply to this email if you have any questions!</p>

            <p>Happy vending,<br>The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Onboarding Day 2 - Add first machine and print QR code
  onboardingDay2: (userName) => ({
    subject: 'Your first step: Add a machine and print your QR code',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
          .button { display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0;">Add Your First Machine</h2>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>The fastest way to start seeing results with IDDI: add your first machine, generate the QR code, and print it out. It takes about 60 seconds and everything you need is on your dashboard.</p>
            <p>Once the QR code is on your machine, customers can start telling you what they actually want to buy.</p>

            <center>
              <a href="${FRONTEND_URL}/vendor/machines" class="button">Go to Dashboard</a>
            </center>

            <p>Happy vending,<br>The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Onboarding Day 5 - Encourage QR code placement and voting
  onboardingDay5: (userName, stats) => ({
    subject: 'Your customers are ready to vote',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #10B981; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
          .button { display: inline-block; background: #10B981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0;">Get Your First Votes</h2>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>Have you stuck your QR code on your machine yet? When customers scan it, they swipe to vote on the products they want to see. It's like a focus group that runs 24/7 -- for free.</p>
            <p>The sooner you get votes, the sooner you know what to stock.</p>

            <center>
              <a href="${FRONTEND_URL}/vendor/dashboard" class="button">Check Your Dashboard</a>
            </center>

            <p>Happy vending,<br>The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Onboarding Day 10 - Show estimated impact and referral program
  onboardingDay10: (userName, stats) => ({
    subject: 'How IDDI is working for you',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
          .button { display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .highlight { background: #EEF2FF; border-left: 4px solid #4F46E5; padding: 15px; margin: 20px 0; border-radius: 0 6px 6px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0;">Your IDDI Impact</h2>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>Based on operators like you, IDDI helps reduce spoilage by 25% and increase sales by 18%. That could mean an extra $${stats && stats.estimatedMonthlySavings ? stats.estimatedMonthlySavings : '50-150'} per month across your machines.</p>

            <center>
              <a href="${FRONTEND_URL}/vendor/dashboard" class="button">View Your Dashboard</a>
            </center>

            <div class="highlight">
              <strong>Know another operator?</strong> Share your referral link and you both get a free month.
            </div>

            <p>Happy vending,<br>The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Onboarding Day 13 - Gentle upgrade prompt
  onboardingDay13: (userName) => ({
    subject: 'Ready to add more machines?',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #7C3AED; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
          .button { display: inline-block; background: #7C3AED; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0;">Scale Your Operation</h2>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>You've been using IDDI on 1 machine. Growth ($19/mo) lets you manage up to 10 machines -- that's less than $2 per machine per month.</p>
            <p>Not ready? No problem -- your free machine is yours forever.</p>

            <center>
              <a href="${FRONTEND_URL}/vendor/pricing" class="button">See Pricing</a>
            </center>

            <p>Happy vending,<br>The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Weekly Digest - sent every Monday with performance summary
  weeklyDigest: (userName, stats) => ({
    subject: `Your Weekly IDDI Report — ${stats.topProduct || 'See your stats'}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 24px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
          .stat-grid { display: flex; gap: 12px; margin: 20px 0; }
          .stat-card { flex: 1; background: #F9FAFB; border-radius: 8px; padding: 16px; text-align: center; }
          .stat-number { font-size: 28px; font-weight: 800; color: #4F46E5; }
          .stat-label { font-size: 12px; color: #6B7280; text-transform: uppercase; }
          .button { display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .highlight { background: #EEF2FF; border-left: 4px solid #4F46E5; padding: 15px; margin: 20px 0; border-radius: 0 6px 6px 0; }
          .alert { background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 12px 15px; margin: 15px 0; border-radius: 0 6px 6px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
          .tip { background: #F0FDF4; border: 1px solid #BBF7D0; padding: 16px; border-radius: 8px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0 0 4px;">Weekly Report</h2>
            <p style="margin: 0; opacity: 0.9; font-size: 14px;">${stats.weekRange || 'This week'}</p>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>Here's how your machines performed this week:</p>

            <div class="stat-grid">
              <div class="stat-card">
                <div class="stat-number">${stats.totalVotes || 0}</div>
                <div class="stat-label">Customer Votes</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${stats.qrScans || 0}</div>
                <div class="stat-label">QR Scans</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${stats.machineCount || 0}</div>
                <div class="stat-label">Active Machines</div>
              </div>
            </div>

            ${stats.topProduct ? `
            <div class="highlight">
              <strong>🏆 Top Product This Week:</strong> ${stats.topProduct}
              ${stats.topProductVotes ? ` — ${stats.topProductVotes} votes` : ''}
            </div>
            ` : ''}

            ${stats.expiringCount > 0 ? `
            <div class="alert">
              <strong>⚠️ ${stats.expiringCount} product${stats.expiringCount > 1 ? 's' : ''} expiring soon.</strong>
              Check your dashboard to redistribute or discount before they expire.
            </div>
            ` : ''}

            ${stats.newSuggestions > 0 ? `
            <p>💡 <strong>${stats.newSuggestions} new product suggestion${stats.newSuggestions > 1 ? 's' : ''}</strong> from customers this week. <a href="${FRONTEND_URL}/vendor/suggestions" style="color: #4F46E5;">Review them →</a></p>
            ` : ''}

            <div class="tip">
              <strong>💡 Tip of the Week:</strong> ${stats.tip || 'Operators who check poll results weekly and swap underperformers see an average 18% revenue increase within 60 days.'}
            </div>

            <center>
              <a href="${FRONTEND_URL}/vendor/dashboard" class="button">View Full Dashboard</a>
            </center>

            ${stats.referralCount !== undefined ? `
            <p style="text-align: center; color: #6B7280; font-size: 14px; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
              📣 You've referred <strong>${stats.referralCount}</strong> operator${stats.referralCount !== 1 ? 's' : ''}.
              <a href="${FRONTEND_URL}/vendor/dashboard" style="color: #4F46E5;">Share your link</a> — both of you get a free month.
            </p>
            ` : ''}

            <p>Happy vending,<br>The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
            <p style="font-size: 12px;"><a href="${FRONTEND_URL}/vendor/settings" style="color: #6b7280;">Manage email preferences</a></p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Re-engagement email - sent after 7 days of inactivity
  reEngagement: (userName) => ({
    subject: 'We miss you! Your vending data is waiting',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #F59E0B; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
          .button { display: inline-block; background: #F59E0B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0;">Your Dashboard Misses You!</h2>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>It's been a week since your last visit. Your vending machines are still working hard - are you tracking their performance?</p>

            <p><strong>Quick reminder of what you can do:</strong></p>
            <ul>
              <li>Check which products are selling well</li>
              <li>Get redistribution suggestions</li>
              <li>Review customer poll results</li>
              <li>Track expiring inventory</li>
            </ul>

            <center>
              <a href="${FRONTEND_URL}/vendor/dashboard" class="button">Check Your Dashboard</a>
            </center>

            <p>Need help? Just reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Email verification - sent on registration
  emailVerification: (userName, verificationCode) => ({
    subject: 'Verify your IDDI account',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
          .code-box { background: #F3F4F6; border: 2px solid #4F46E5; padding: 20px; text-align: center; margin: 25px 0; border-radius: 8px; }
          .code { font-size: 36px; font-weight: bold; color: #4F46E5; letter-spacing: 8px; font-family: monospace; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
          .warning { color: #DC2626; font-size: 13px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Verify Your Email</h1>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>Welcome to IDDI! To complete your registration and secure your account, please enter the verification code below:</p>

            <div class="code-box">
              <div class="code">${verificationCode}</div>
            </div>

            <p style="text-align: center; color: #6b7280;">Enter this code on the verification page to activate your account.</p>

            <p class="warning">This code expires in 15 minutes. If you didn't create an IDDI account, please ignore this email.</p>

            <p style="margin-top: 30px;">Questions? Reply to this email and we'll help you out.</p>

            <p>- The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Password reset request
  passwordReset: (userName, resetToken) => ({
    subject: 'Reset your IDDI password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #DC2626; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 20px 0; font-size: 16px; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
          .warning { background: #FEF3C7; border: 1px solid #F59E0B; padding: 15px; border-radius: 6px; margin: 20px 0; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Password Reset</h1>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>We received a request to reset your IDDI account password. Click the button below to choose a new password:</p>

            <center>
              <a href="${FRONTEND_URL}/vendor/reset-password?token=${resetToken}" class="button">Reset Password</a>
            </center>

            <div class="warning">
              <strong>This link expires in 1 hour.</strong><br>
              If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.
            </div>

            <p style="margin-top: 30px; font-size: 13px; color: #6b7280;">
              If the button doesn't work, copy and paste this link into your browser:<br>
              <span style="word-break: break-all;">${FRONTEND_URL}/vendor/reset-password?token=${resetToken}</span>
            </p>

            <p>- The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Lead magnet delivery - sent when someone downloads a resource
  leadMagnetDelivery: (userName, leadMagnet) => {
    const magnetLinks = {
      startup_kit: {
        title: 'Vending Machine Startup Kit',
        description: 'Your complete guide to starting and growing a vending machine business.',
        ctaText: 'Download Your Startup Kit',
        ctaUrl: `${FRONTEND_URL}/resources/startup-kit`,
      },
      calculator_results: {
        title: 'Your Vending ROI Calculator Results',
        description: 'Your personalized vending machine profitability analysis is ready.',
        ctaText: 'View Your Results',
        ctaUrl: `${FRONTEND_URL}/calculator/results`,
      },
      location_guide: {
        title: 'Best Vending Machine Locations Guide',
        description: 'Our top picks for high-traffic vending locations and how to secure them.',
        ctaText: 'Download Location Guide',
        ctaUrl: `${FRONTEND_URL}/resources/location-guide`,
      },
    };

    const magnet = magnetLinks[leadMagnet] || {
      title: 'Your IDDI Resource',
      description: 'Thanks for your interest! Here is your requested resource.',
      ctaText: 'Access Your Resource',
      ctaUrl: `${FRONTEND_URL}/resources`,
    };

    return {
      subject: `Your ${magnet.title} is ready!`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; background: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 20px 0; font-size: 16px; }
            .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
            .highlight { background: #EEF2FF; border-left: 4px solid #4F46E5; padding: 15px; margin: 20px 0; border-radius: 0 6px 6px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">${magnet.title}</h1>
            </div>
            <div class="content">
              <p>Hi ${userName || 'there'},</p>
              <p>${magnet.description}</p>

              <center>
                <a href="${magnet.ctaUrl}" class="button">${magnet.ctaText}</a>
              </center>

              <div class="highlight">
                <strong>Want to put these insights into action?</strong><br>
                IDDI helps vending operators track inventory, run customer polls, and optimize product placement - all from one dashboard.
              </div>

              <center>
                <a href="${FRONTEND_URL}/vendor/register" style="color: #4F46E5; font-weight: bold;">Try IDDI Free</a>
              </center>

              <p style="margin-top: 30px;">- The IDDI Team</p>
            </div>
            <div class="footer">
              <p>IDDI - Smart Vending Machine Management</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };
  },

  // Referral notification - sent to referrer when someone signs up via their code
  referralNotification: (userName, referredName) => ({
    subject: `${referredName} just joined IDDI through your referral!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #10B981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
          .celebration { font-size: 48px; text-align: center; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">New Referral!</h1>
          </div>
          <div class="content">
            <div class="celebration">&#127881;</div>
            <p>Hi ${userName},</p>
            <p>Great news! <strong>${referredName}</strong> just signed up for IDDI using your referral link.</p>

            <p>Thanks for spreading the word about smarter vending machine management. Keep sharing your referral link to grow the community!</p>

            <center>
              <a href="${FRONTEND_URL}/vendor/dashboard" class="button">View Your Referrals</a>
            </center>

            <p>- The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Password changed confirmation
  passwordChanged: (userName) => ({
    subject: 'Your IDDI password has been changed',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #10B981; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 20px 0; font-size: 16px; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
          .warning { background: #FEE2E2; border: 1px solid #DC2626; padding: 15px; border-radius: 6px; margin: 20px 0; font-size: 14px; color: #DC2626; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Password Changed</h1>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>Your IDDI account password has been successfully changed.</p>

            <center>
              <a href="${FRONTEND_URL}/vendor/login" class="button">Sign In Now</a>
            </center>

            <div class="warning">
              <strong>Didn't make this change?</strong><br>
              If you didn't change your password, please contact us immediately by replying to this email. Your account may have been compromised.
            </div>

            <p>- The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Spoilage alert - automated notification for expiring products
  spoilageAlert: (userName, alertData) => ({
    subject: `Action Required: ${alertData.totalProducts} product(s) expiring soon`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #DC2626; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #DC2626; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 20px 0; font-size: 16px; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
          .machine-group { background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; padding: 16px; margin: 16px 0; }
          .product-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #FEE2E2; }
          .product-row:last-child { border-bottom: none; }
          .days-badge { background: #DC2626; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
          .days-badge.warning { background: #F59E0B; }
          .suggestions { background: #EEF2FF; border-left: 4px solid #4F46E5; padding: 16px; margin: 20px 0; border-radius: 0 8px 8px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">Spoilage Alert</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">${alertData.totalProducts} product(s) expiring within 7 days</p>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>The following products in your vending machines are expiring soon and may need attention:</p>

            ${alertData.machines.map(machine => `
              <div class="machine-group">
                <h3 style="margin: 0 0 12px 0;">${machine.machineName} — ${machine.location}</h3>
                ${machine.products.map(product => `
                  <div class="product-row">
                    <span>${product.productName} (qty: ${product.stock})</span>
                    <span class="days-badge${product.daysUntilExpiry > 3 ? ' warning' : ''}">${product.daysUntilExpiry <= 0 ? 'EXPIRED' : product.daysUntilExpiry + 'd left'}</span>
                  </div>
                `).join('')}
              </div>
            `).join('')}

            <div class="suggestions">
              <h3 style="margin: 0 0 8px 0;">Suggested Actions</h3>
              <ul style="margin: 0; padding-left: 20px;">
                <li><strong>Redistribute</strong> — Move soon-to-expire products to higher-traffic machines</li>
                <li><strong>Discount</strong> — Consider marking down prices to clear stock</li>
                <li><strong>Remove</strong> — Pull expired products to maintain quality</li>
              </ul>
            </div>

            <center>
              <a href="${FRONTEND_URL}/vendor/expiring" class="button">Review Expiring Products</a>
            </center>

            <p>Stay on top of your inventory to reduce waste and protect margins.</p>
            <p>- The IDDI Team</p>
          </div>
          <div class="footer">
            <p>IDDI - Smart Vending Machine Management</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Support ticket notification — sent to admin when a user submits a ticket
  supportTicketNotification: (_, data) => ({
    subject: `[IDDI Support] #${data.ticketId}: ${data.subject}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #4F46E5;">New Support Ticket #${data.ticketId}</h2>
        <p><strong>From:</strong> ${data.userName} (${data.userEmail})</p>
        <p><strong>Subject:</strong> ${data.subject}</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
        <p>${(data.message || '').replace(/\n/g, '<br>')}</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
        <p style="color: #6b7280; font-size: 13px;">Reply to the customer at ${data.userEmail}</p>
      </body>
      </html>
    `,
  }),

  shoppingList: (userName, data) => {
    const products = Array.isArray(data.products) ? data.products : [];
    const windowDays = data.windowDays || 90;
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rows = products.map((p, i) => `
      <tr>
        <td style="padding: 10px 12px; border-bottom: 1px solid #E5E7EB; font-weight: 600; width: 28px; color: #6B7280;">${i + 1}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #E5E7EB;">
          <div style="font-weight: 600;">${p.product_name}</div>
          ${p.category ? `<div style="font-size: 12px; color: #6B7280; margin-top: 2px;">${p.category}</div>` : ''}
        </td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #E5E7EB; text-align: right; white-space: nowrap;">
          <span style="font-weight: 700; color: #10B981;">${p.total_yes} good</span>
          <span style="color: #6B7280; font-size: 12px;"> / ${p.total_no} bad</span>
          <div style="font-size: 12px; color: #6B7280; margin-top: 2px;">${p.approval_rate}% approval • ${p.machine_count} machine${Number(p.machine_count) === 1 ? '' : 's'}</div>
        </td>
      </tr>
    `).join('');

    const plainLines = products.map((p, i) =>
      `${i + 1}. ${p.product_name} — ${p.total_yes} good / ${p.total_no} bad (${p.approval_rate}%), ${p.machine_count} machine${Number(p.machine_count) === 1 ? '' : 's'}`
    ).join('\n');

    return {
      subject: `Your IDDI Shopping List — ${date} (${products.length} item${products.length === 1 ? '' : 's'})`,
      html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; background: #F9FAFB; margin: 0; padding: 20px;">
        <div style="max-width: 640px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 24px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0 0 4px;">IDDI Shopping List</h2>
            <p style="margin: 0; opacity: 0.9; font-size: 14px;">${date} • based on performance over the last ${windowDays} days</p>
          </div>
          <div style="background: #fff; padding: 24px; border: 1px solid #E5E7EB; border-top: none;">
            <p style="margin: 0 0 16px;">Hi ${userName},</p>
            <p style="margin: 0 0 16px;">Here are the products performing well enough to restock — sorted by approval rate:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 8px 0 20px;">
              ${rows || '<tr><td style="padding: 16px; color: #6B7280;">No qualifying products yet.</td></tr>'}
            </table>
            <p style="margin: 16px 0 0; font-size: 13px; color: #6B7280;">Plain text (easy to copy into notes):</p>
            <pre style="background: #F3F4F6; padding: 12px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; color: #111; margin: 8px 0 0;">${plainLines || 'No qualifying products yet.'}</pre>
            <div style="margin-top: 24px; text-align: center;">
              <a href="${FRONTEND_URL}/vendor/poll-summary" style="display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Open Shopping List in IDDI</a>
            </div>
          </div>
          <div style="text-align: center; padding: 16px; color: #6B7280; font-size: 13px;">IDDI • Smarter vending, fewer guesses</div>
        </div>
      </body>
      </html>
      `,
    };
  },
};

// Send email function
async function sendEmail(to, templateName, templateData = {}) {
  if (!resend) {
    return { success: true, mock: true };
  }

  try {
    const template = templates[templateName];
    if (!template) {
      throw new Error(`Unknown email template: ${templateName}`);
    }

    // Handle different template signatures
    let emailContent;
    if (templateName === 'emailVerification') {
      emailContent = template(templateData.userName || 'there', templateData.verificationCode);
    } else if (templateName === 'passwordReset') {
      emailContent = template(templateData.userName || 'there', templateData.resetToken);
    } else if (templateName === 'leadMagnetDelivery') {
      emailContent = template(templateData.userName || 'there', templateData.leadMagnet);
    } else if (templateName === 'referralNotification') {
      emailContent = template(templateData.userName || 'there', templateData.referredName || 'Someone');
    } else if (templateName === 'spoilageAlert') {
      emailContent = template(templateData.userName || 'there', templateData);
    } else if (templateName === 'onboardingDay5' || templateName === 'onboardingDay10') {
      emailContent = template(templateData.userName || 'there', templateData.stats || {});
    } else if (templateName === 'weeklyDigest') {
      emailContent = template(templateData.userName || 'there', templateData.stats || {});
    } else if (templateName === 'supportTicketNotification') {
      emailContent = template(null, templateData);
    } else if (templateName === 'shoppingList') {
      emailContent = template(templateData.userName || 'there', templateData);
    } else {
      emailContent = template(templateData.userName || 'there');
    }

    const { subject, html } = emailContent;

    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
    });

    return { success: true, id: result.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Schedule onboarding sequence
async function scheduleOnboardingSequence(userId, email, userName) {
  const { query } = require('../config/database');

  try {
    // Send welcome email immediately
    await sendEmail(email, 'welcome', { userName });

    // Schedule future emails (stored in DB, processed by cron job)
    const scheduledEmails = [
      { template: 'onboardingDay2', sendAt: 'NOW() + INTERVAL \'2 days\'' },
      { template: 'onboardingDay5', sendAt: 'NOW() + INTERVAL \'5 days\'' },
      { template: 'onboardingDay10', sendAt: 'NOW() + INTERVAL \'10 days\'' },
      { template: 'onboardingDay13', sendAt: 'NOW() + INTERVAL \'13 days\'' },
    ];

    for (const scheduled of scheduledEmails) {
      await query(
        `INSERT INTO scheduled_emails (user_id, email, template_name, scheduled_for, status)
         VALUES ($1, $2, $3, ${scheduled.sendAt}, 'pending')
         ON CONFLICT DO NOTHING`,
        [userId, email, scheduled.template]
      );
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendEmail,
  scheduleOnboardingSequence,
  templates,
};
