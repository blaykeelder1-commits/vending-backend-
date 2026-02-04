const { Resend } = require('resend');

let resend = null;

// Initialize Resend if API key is provided
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
} else {
}

// Use Resend's onboarding email until a custom domain is verified
// To use your own domain, verify it at https://resend.com/domains and set RESEND_FROM_EMAIL
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'IDDI <onboarding@resend.dev>';
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
