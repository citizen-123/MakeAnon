/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Health check
 *     description: Check the health status of the API and its dependencies
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 status: { type: string, enum: [healthy, degraded, unhealthy] }
 *                 checks:
 *                   type: object
 *                   properties:
 *                     database: { type: boolean }
 *                     redis: { type: boolean }
 *                 timestamp: { type: string, format: date-time }
 *                 version: { type: string }
 *       503:
 *         description: Service is unhealthy
 */

/**
 * @openapi
 * /stats:
 *   get:
 *     tags: [Health]
 *     summary: Global statistics
 *     description: Get global statistics about the service
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalAliases: { type: integer }
 *                     activeAliases: { type: integer }
 *                     totalUsers: { type: integer }
 *                     domainsCount: { type: integer }
 */

/**
 * @openapi
 * /alias:
 *   post:
 *     tags: [Public]
 *     summary: Create a public alias
 *     description: Create a new email alias without authentication. A verification email will be sent.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [destinationEmail]
 *             properties:
 *               destinationEmail:
 *                 type: string
 *                 format: email
 *                 description: Your real email address where forwarded emails will be sent
 *               customAlias:
 *                 type: string
 *                 description: Optional custom alias name (4-32 chars, alphanumeric)
 *               domain:
 *                 type: string
 *                 description: Domain to use (defaults to makeanon.info)
 *               label:
 *                 type: string
 *                 description: Optional label for the alias
 *               description:
 *                 type: string
 *                 description: Optional description
 *               replyEnabled:
 *                 type: boolean
 *                 default: true
 *                 description: Enable reply functionality
 *     responses:
 *       201:
 *         description: Alias created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     alias: { $ref: '#/components/schemas/Alias' }
 *                     managementToken: { type: string }
 *                     message: { type: string }
 *       400:
 *         description: Invalid request
 *       409:
 *         description: Alias already exists
 */

/**
 * @openapi
 * /domains:
 *   get:
 *     tags: [Public]
 *     summary: List available domains
 *     description: Get a list of all active public domains available for alias creation
 *     responses:
 *       200:
 *         description: List of domains
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Domain'
 */

/**
 * @openapi
 * /verify/{token}:
 *   get:
 *     tags: [Public]
 *     summary: Verify email address
 *     description: Verify an alias email address using the verification token sent via email
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Email verified successfully
 *       400:
 *         description: Invalid or expired token
 */

/**
 * @openapi
 * /verify/resend:
 *   post:
 *     tags: [Public]
 *     summary: Resend verification email
 *     description: Resend the verification email for an alias
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [aliasEmail]
 *             properties:
 *               aliasEmail:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Verification email sent
 *       404:
 *         description: Alias not found
 */

/**
 * @openapi
 * /management-link:
 *   post:
 *     tags: [Public]
 *     summary: Request management link
 *     description: Request a new management link for a public alias (sent to destination email)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [aliasEmail]
 *             properties:
 *               aliasEmail:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Management link sent
 *       404:
 *         description: Alias not found
 */

/**
 * @openapi
 * /manage/{token}:
 *   get:
 *     tags: [Public]
 *     summary: Get alias by management token
 *     description: Retrieve alias details using the management token
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Alias details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/Alias' }
 *       404:
 *         description: Alias not found
 *   put:
 *     tags: [Public]
 *     summary: Update alias by management token
 *     description: Update alias settings using the management token
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label: { type: string }
 *               description: { type: string }
 *               isActive: { type: boolean }
 *               replyEnabled: { type: boolean }
 *     responses:
 *       200:
 *         description: Alias updated
 *       404:
 *         description: Alias not found
 *   delete:
 *     tags: [Public]
 *     summary: Delete alias by management token
 *     description: Permanently delete an alias using the management token
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Alias deleted
 *       404:
 *         description: Alias not found
 */

/**
 * @openapi
 * /manage/{token}/block:
 *   post:
 *     tags: [Public]
 *     summary: Block a sender
 *     description: Block a sender from sending emails to this alias
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 description: Email address or regex pattern to block
 *               isPattern:
 *                 type: boolean
 *                 default: false
 *                 description: Whether email is a regex pattern
 *     responses:
 *       200:
 *         description: Sender blocked
 *       404:
 *         description: Alias not found
 */

/**
 * @openapi
 * /manage/{token}/block/{senderId}:
 *   delete:
 *     tags: [Public]
 *     summary: Unblock a sender
 *     description: Remove a sender from the blocked list
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: senderId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sender unblocked
 *       404:
 *         description: Alias or sender not found
 */

/**
 * @openapi
 * /auth/signup:
 *   post:
 *     tags: [Auth]
 *     summary: Create a new account
 *     description: Register a new user account
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       201:
 *         description: Account created
 *       400:
 *         description: Invalid request
 *       409:
 *         description: Email already registered
 */

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login
 *     description: Authenticate and receive a JWT token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     token: { type: string }
 *                     user:
 *                       type: object
 *                       properties:
 *                         id: { type: string }
 *                         email: { type: string }
 *       401:
 *         description: Invalid credentials
 */

/**
 * @openapi
 * /auth/profile:
 *   get:
 *     tags: [Auth]
 *     summary: Get profile
 *     description: Get the current user's profile
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile data
 *       401:
 *         description: Unauthorized
 *   put:
 *     tags: [Auth]
 *     summary: Update profile
 *     description: Update the current user's profile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Profile updated
 *       401:
 *         description: Unauthorized
 */

/**
 * @openapi
 * /auth/change-password:
 *   post:
 *     tags: [Auth]
 *     summary: Change password
 *     description: Change the current user's password
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string }
 *               newPassword: { type: string, minLength: 8 }
 *     responses:
 *       200:
 *         description: Password changed
 *       401:
 *         description: Unauthorized or wrong password
 */

/**
 * @openapi
 * /auth/account:
 *   delete:
 *     tags: [Auth]
 *     summary: Delete account
 *     description: Permanently delete the current user's account and all aliases
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Account deleted
 *       401:
 *         description: Unauthorized
 */

/**
 * @openapi
 * /aliases:
 *   get:
 *     tags: [Aliases]
 *     summary: List aliases
 *     description: Get all aliases for the authenticated user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: search
 *         in: query
 *         schema:
 *           type: string
 *       - name: isActive
 *         in: query
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: List of aliases
 *       401:
 *         description: Unauthorized
 *   post:
 *     tags: [Aliases]
 *     summary: Create private alias
 *     description: Create a new private alias (owned by authenticated user)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               customAlias: { type: string }
 *               domain: { type: string }
 *               label: { type: string }
 *               description: { type: string }
 *               replyEnabled: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: Alias created
 *       401:
 *         description: Unauthorized
 */

/**
 * @openapi
 * /aliases/stats:
 *   get:
 *     tags: [Aliases]
 *     summary: Get alias statistics
 *     description: Get statistics for the authenticated user's aliases
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics
 *       401:
 *         description: Unauthorized
 */

/**
 * @openapi
 * /aliases/logs:
 *   get:
 *     tags: [Aliases]
 *     summary: Get email logs
 *     description: Get email activity logs for the authenticated user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *       - name: aliasId
 *         in: query
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Email logs
 *       401:
 *         description: Unauthorized
 */

/**
 * @openapi
 * /aliases/{id}:
 *   get:
 *     tags: [Aliases]
 *     summary: Get alias
 *     description: Get a specific alias by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Alias details
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Alias not found
 *   put:
 *     tags: [Aliases]
 *     summary: Update alias
 *     description: Update a specific alias
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label: { type: string }
 *               description: { type: string }
 *               isActive: { type: boolean }
 *               replyEnabled: { type: boolean }
 *     responses:
 *       200:
 *         description: Alias updated
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Alias not found
 *   delete:
 *     tags: [Aliases]
 *     summary: Delete alias
 *     description: Permanently delete an alias
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Alias deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Alias not found
 */

/**
 * @openapi
 * /aliases/{id}/toggle:
 *   post:
 *     tags: [Aliases]
 *     summary: Toggle alias
 *     description: Toggle an alias active/inactive
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Alias toggled
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Alias not found
 */

export {};
