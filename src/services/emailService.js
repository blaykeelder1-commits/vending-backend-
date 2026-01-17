const { Resend } = require('resend');

let resend = null;

// Initialize Resend if API key is provided
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
  console.log('Resend email service initialized');
} else {
  console.log('Resend email service disabled (no API key provided)');
}

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'IDDI <noreply@iddi.app>';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://vending-front-end.vercel.app';

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

  // Onboarding Day 2 - Add first machine reminder
  onboardingDay2: (userName) => ({
    subject: 'Quick Tip: Add Your First Machine in 60 Seconds',
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
          .step { background: #F3F4F6; padding: 15px; margin: 10px 0; border-radius: 6px; }
          .step-number { background: #4F46E5; color: white; width: 24px; height: 24px; border-radius: 50%; display: inline-block; text-align: center; margin-right: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0;">Add Your First Machine</h2>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>Ready to see IDDI in action? Here's how to add your first machine:</p>

            <div class="step">
              <span class="step-number">1</span> Click "Add Machine" from your dashboard
            </div>
            <div class="step">
              <span class="step-number">2</span> Enter the machine name and location
            </div>
            <div class="step">
              <span class="step-number">3</span> That's it! Your QR code is auto-generated
            </div>

            <center>
              <a href="${FRONTEND_URL}/vendor/machines" class="button">Add Machine Now</a>
            </center>

            <p>Once added, you can start tracking inventory and customer preferences right away.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),

  // Onboarding Day 5 - Introduce performance tracking
  onboardingDay5: (userName) => ({
    subject: 'Pro Tip: Find Out Which Products Actually Sell',
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
          .highlight { background: #ECFDF5; border-left: 4px solid #10B981; padding: 15px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0;">Know What Sells, What Doesn't</h2>
          </div>
          <div class="content">
            <p>Hi ${userName},</p>
            <p>Ever wondered which products are just taking up space?</p>

            <div class="highlight">
              <strong>Performance Tracking</strong> lets you mark products as "performing" or "not performing" at each machine. Over time, you'll see patterns that help you make better stocking decisions.
            </div>

            <p><strong>The result?</strong> Less waste, more sales, happier customers.</p>

            <center>
              <a href="${FRONTEND_URL}/vendor/machines" class="button">Start Tracking Performance</a>
            </center>
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

  // Referral invitation
  referralInvite: (referrerName, referralCode) => ({
    subject: `${referrerName} invited you to try IDDI`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
          .button { display: inline-block; background: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 20px 0; font-size: 16px; }
          .code-box { background: #F3F4F6; border: 2px dashed #4F46E5; padding: 15px; text-align: center; margin: 20px 0; border-radius: 6px; }
          .code { font-size: 24px; font-weight: bold; color: #4F46E5; letter-spacing: 2px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">You're Invited!</h1>
          </div>
          <div class="content">
            <p><strong>${referrerName}</strong> thinks you'd love IDDI - the smart way to manage vending machines.</p>

            <p>Join for free and get extended trial access when you sign up with this code:</p>

            <div class="code-box">
              <div class="code">${referralCode}</div>
            </div>

            <center>
              <a href="${FRONTEND_URL}/register?ref=${referralCode}" class="button">Join IDDI Free</a>
            </center>

            <p><strong>What is IDDI?</strong></p>
            <p>IDDI helps vending operators track inventory, analyze product performance, and make smarter stocking decisions. It's free to start.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  }),
};

// Send email function
async function sendEmail(to, templateName, templateData = {}) {
  if (!resend) {
    console.log(`[Email Mock] Would send "${templateName}" to ${to}`);
    return { success: true, mock: true };
  }

  try {
    const template = templates[templateName];
    if (!template) {
      throw new Error(`Unknown email template: ${templateName}`);
    }

    const { subject, html } = template(templateData.userName || 'there', templateData.referralCode);

    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
    });

    console.log(`[Email] Sent "${templateName}" to ${to}`, result);
    return { success: true, id: result.id };
  } catch (error) {
    console.error(`[Email Error] Failed to send "${templateName}" to ${to}:`, error);
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
    ];

    for (const scheduled of scheduledEmails) {
      await query(
        `INSERT INTO scheduled_emails (user_id, email, template_name, scheduled_for, status)
         VALUES ($1, $2, $3, ${scheduled.sendAt}, 'pending')
         ON CONFLICT DO NOTHING`,
        [userId, email, scheduled.template]
      );
    }

    console.log(`[Email] Scheduled onboarding sequence for user ${userId}`);
    return { success: true };
  } catch (error) {
    console.error('[Email] Error scheduling onboarding sequence:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendEmail,
  scheduleOnboardingSequence,
  templates,
};
