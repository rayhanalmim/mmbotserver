/**
 * Installment Routes
 * Handles GCB token distribution records for investors
 */

export function setupInstallmentRoutes(app, db, verifyMexcToken) {
  
  // POST /api/installment/record - Save a new installment transaction record
  app.post('/api/installment/record', verifyMexcToken, async (req, res) => {
    try {
      const {
        fileName,
        totalRecipients,
        totalAmount,
        successCount,
        failedCount,
        senderAddress,
        batchTxHash,
        recipients
      } = req.body;

      // Validate required fields
      if (!fileName || !recipients || !Array.isArray(recipients)) {
        return res.status(400).json({ 
          code: '-1', 
          msg: 'Missing required fields', 
          data: null 
        });
      }

      // Create record
      const record = {
        mexcUserId: req.mexcUser.id,
        fileName,
        totalRecipients: totalRecipients || recipients.length,
        totalAmount: totalAmount || 0,
        successCount: successCount || 0,
        failedCount: failedCount || 0,
        senderAddress: senderAddress || '',
        batchTxHash: batchTxHash || null,
        transferMethod: batchTxHash ? 'batch' : 'individual',
        recipients: recipients.map(r => ({
          address: r.address,
          amount: r.amount,
          status: r.status,
          txHash: r.txHash || null,
          error: r.error || null
        })),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await db.collection('installment_records').insertOne(record);

      console.log(`📦 Installment record saved: ${fileName} - ${totalRecipients} recipients, ${totalAmount} GCB (${record.transferMethod} transfer)`);

      res.json({
        code: '0',
        msg: 'Installment record saved successfully',
        data: { id: result.insertedId }
      });

    } catch (error) {
      console.error('Error saving installment record:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to save installment record', 
        data: null 
      });
    }
  });

  // GET /api/installment/history - Get installment transaction history for today
  app.get('/api/installment/history', verifyMexcToken, async (req, res) => {
    try {
      // Get start of today
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const records = await db.collection('installment_records')
        .find({
          mexcUserId: req.mexcUser.id,
          createdAt: { $gte: today }
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      res.json({
        code: '0',
        msg: 'Success',
        data: records
      });

    } catch (error) {
      console.error('Error fetching installment history:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to fetch installment history', 
        data: null 
      });
    }
  });

  // GET /api/installment/history/all - Get all installment transaction history
  app.get('/api/installment/history/all', verifyMexcToken, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;

      const records = await db.collection('installment_records')
        .find({ mexcUserId: req.mexcUser.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      const total = await db.collection('installment_records')
        .countDocuments({ mexcUserId: req.mexcUser.id });

      res.json({
        code: '0',
        msg: 'Success',
        data: {
          records,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
          }
        }
      });

    } catch (error) {
      console.error('Error fetching all installment history:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to fetch installment history', 
        data: null 
      });
    }
  });

  // GET /api/installment/record/:id - Get a specific installment record
  app.get('/api/installment/record/:id', verifyMexcToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const recordId = req.params.id;

      if (!ObjectId.isValid(recordId)) {
        return res.status(400).json({ 
          code: '-1', 
          msg: 'Invalid record ID format', 
          data: null 
        });
      }

      const record = await db.collection('installment_records').findOne({
        _id: new ObjectId(recordId),
        mexcUserId: req.mexcUser.id
      });

      if (!record) {
        return res.status(404).json({ 
          code: '-1', 
          msg: 'Record not found', 
          data: null 
        });
      }

      res.json({
        code: '0',
        msg: 'Success',
        data: record
      });

    } catch (error) {
      console.error('Error fetching installment record:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to fetch installment record', 
        data: null 
      });
    }
  });

  // GET /api/installment/stats - Get installment statistics
  app.get('/api/installment/stats', verifyMexcToken, async (req, res) => {
    try {
      const pipeline = [
        { $match: { mexcUserId: req.mexcUser.id } },
        {
          $group: {
            _id: null,
            totalDistributions: { $sum: 1 },
            totalRecipients: { $sum: '$totalRecipients' },
            totalAmountSent: { $sum: '$totalAmount' },
            totalSuccess: { $sum: '$successCount' },
            totalFailed: { $sum: '$failedCount' }
          }
        }
      ];

      const stats = await db.collection('installment_records')
        .aggregate(pipeline)
        .toArray();

      res.json({
        code: '0',
        msg: 'Success',
        data: stats[0] || {
          totalDistributions: 0,
          totalRecipients: 0,
          totalAmountSent: 0,
          totalSuccess: 0,
          totalFailed: 0
        }
      });

    } catch (error) {
      console.error('Error fetching installment stats:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to fetch installment stats', 
        data: null 
      });
    }
  });

  console.log('✅ Installment routes initialized');
}
