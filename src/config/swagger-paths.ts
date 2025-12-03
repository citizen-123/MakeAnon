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
 *     tags: [Aliases]
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
 *     tags: [Domains]
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
 *     tags: [Aliases]
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
 *     tags: [Aliases]
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
 * /manage/{token}:
 *   get:
 *     tags: [Aliases]
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
 *     tags: [Aliases]
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
 *     tags: [Aliases]
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
 *     tags: [Aliases]
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
 *     tags: [Aliases]
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

export {};
