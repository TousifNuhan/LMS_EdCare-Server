const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SSLCommerzPayment = require('sslcommerz-lts');
const port = process.env.PORT || 5001;

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://edcare-56e4b.web.app",
    "https://edcare-56e4b.firebaseapp.com",
  ],   //production a dewar age eta change krte hbe
  credentials: true
}))
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sslcz = new SSLCommerzPayment(
  process.env.SSLC_STORE_ID,
  process.env.SSLC_STORE_PASSWORD,
  process.env.SSLC_IS_LIVE === 'true'
);

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.l6latif.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // await client.connect();


    // Collection references inside the database context
    const db = client.db('EdCare');
    const classCollection = db.collection('classes');
    const reviewsCollection = db.collection('reviews');
    const cartsCollection = db.collection('carts');
    const usersCollection = db.collection('users');
    const teacherApplicationsCollection = db.collection('teacherApplication')
    const assignmentsCollection = db.collection('assignments');
    const submissionsCollection = db.collection('submissions');
    const paymentCollection = db.collection('payments');
    const enrollmentCollection = db.collection('enrollments');
    const payoutCollection = db.collection("payouts");
    const refundRequestsCollection = db.collection('refundRequests');
    const progressCollection = db.collection('progress');
    const newsletterCollection = db.collection('newsletterSubscribers');
    const pendingPaymentsCollection = db.collection('pendingPayments');
    const settingsCollection = db.collection('settings');

    // jwt related api

    app.post('/jwt', async (req, res) => {
      const user = req.body
      const existingUser = await usersCollection.findOne({ email: user.email });
      if (existingUser?.status === 'deactivated') {
        return res.status(403).send({ message: 'Your account has been deactivated. Please contact support.' });
      }
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' })
      res.send({ token })
    })

    // middlewares

    const verifyToken = (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).send({ message: 'Unauthorized Access' });
      }

      const token = req.headers.authorization.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(403).send({ message: 'Forbidden Access' });
        }
        req.decoded = decoded;
        next();
      });
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email
      const query = { email: email }
      const user = await usersCollection.findOne(query)
      const isAdmin = user?.role === 'admin'
      if (!isAdmin) {
        return res.status(403).send({ message: 'forbidden access' })
      }
      next()
    }

    const verifyTeacher = async (req, res, next) => {
      const email = req.decoded?.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isTeacher = user?.role === 'teacher';

      if (!isTeacher) {
        return res.status(403).send({ message: 'Forbidden Access: Teacher Only' });
      }
      next();
    };

    const verifyTeacherOrAdmin = async (req, res, next) => {
      const email = req.decoded?.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isTeacherOrAdmin = user?.role === 'teacher' || user?.role === 'admin';

      if (!isTeacherOrAdmin) {
        return res.status(403).send({ message: 'Forbidden Access: Teacher or Admin Only' });
      }
      next();
    };

    // ------------------------------------------------------------------
    // 1. POST: Submit Teacher Application
    // ------------------------------------------------------------------
    // app.post('/teacher-applications', verifyToken, async (req, res) => {
    //   const application = req.body;
    //   const userEmail = application.email;

    //   // Check if the user has already applied
    //   const existingApplication = await teacherApplicationsCollection.findOne({ email: userEmail });
    //   if (existingApplication) {
    //     if (existingApplication.status === 'pending') {
    //       return res.status(400).send({ message: 'You already have a pending application.' });
    //     }
    //     if (existingApplication.status === 'approved') {
    //       return res.status(400).send({ message: 'You are already an approved teacher.' });
    //     }
    //   }

    //   const newApplication = {
    //     name: application.name,
    //     email: application.email,
    //     image: application.image,
    //     resume: application.resume || '', // <-- ADDED: Captures the uploaded PDF URL
    //     phone: application.phone || '',
    //     portfolio: application.portfolio || '',
    //     experience: application.experience,
    //     category: application.category,
    //     title: application.title,
    //     bio: application.bio,
    //     status: 'pending', // Default status: pending, approved, rejected
    //     createdAt: new Date(),
    //   };

    //   const result = await teacherApplicationsCollection.insertOne(newApplication);
    //   res.send(result);
    // });

   async function getPlatformFeePercentage() {
  const setting = await settingsCollection.findOne({ key: 'platformFee' });
  return setting?.value ?? 0.10;
}

   // GET: current platform fee
app.get('/admin/settings/platform-fee', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const platformFeePercentage = await getPlatformFeePercentage();
    res.send({ platformFeePercentage });
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch platform fee', error: error.message });
  }
});

// PATCH: update platform fee — only affects NEW sales going forward
app.patch('/admin/settings/platform-fee', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { feePercentage } = req.body;
    const numeric = Number(feePercentage);

    if (isNaN(numeric) || numeric < 0 || numeric > 1) {
      return res.status(400).send({ message: 'feePercentage must be between 0 and 1' });
    }

    await settingsCollection.updateOne(
      { key: 'platformFee' },
      { $set: { value: numeric, updatedAt: new Date() } },
      { upsert: true }
    );

    res.send({ message: 'Platform fee updated successfully — this applies to new sales only, past sales keep their original rate.', platformFeePercentage: numeric });
  } catch (error) {
    res.status(500).send({ message: 'Failed to update platform fee', error: error.message });
  }
});

    app.post('/teacher-applications', async (req, res) => {
      try {
        const application = req.body;

        if (!application.email) {
          return res.status(400).send({ message: "Email is required." });
        }

        const existing = await teacherApplicationsCollection.findOne({ email: application.email });

        if (existing) {
          if (existing.status === 'pending') {
            return res.status(400).send({ message: 'You already have a pending application under review.' });
          }
          if (existing.status === 'approved') {
            return res.status(400).send({ message: 'You are already an approved teacher.' });
          }

          // status === 'rejected' (or any other non-blocking state) — allow resubmission
          if (existing.status === 'rejected') {
            const updatedApplication = {
              ...application,
              status: 'pending',
              createdAt: new Date(),
              // clear any old rejection feedback so it doesn't linger on the new submission
              rejectionReason: '',
            };

            const result = await teacherApplicationsCollection.updateOne(
              { email: application.email },
              { $set: updatedApplication }
            );

            return res.send({ acknowledged: result.acknowledged, resubmitted: true });
          }
        }

        // No existing application at all — first-time submission
        const result = await teacherApplicationsCollection.insertOne({
          ...application,
          status: 'pending',
          createdAt: new Date(),
        });

        res.send(result);
      } catch (error) {
        // console.error('Error submitting teacher application:', error);
        res.status(500).send({ message: "Failed to submit application.", error: error.message });
      }
    });

    app.get('/teacher-applications', verifyToken, verifyAdmin, async (req, res) => {
      const result = await teacherApplicationsCollection.find().toArray();
      res.send(result);
    });

    app.get('/teacher-applications/status/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'Forbidden access' });
      }

      const application = await teacherApplicationsCollection.findOne({ email: email });
      res.send({ status: application?.status || 'none', application });
    });




    // last eta change krslm teacher application r
    // app.patch('/teacher-applications/approve/:id', async (req, res) => {
    //   const id = req.params.id;

    //   // 1. Find the application first to get the applicant's email
    //   const application = await teacherApplicationsCollection.findOne({ _id: new ObjectId(id) });
    //   if (!application) {
    //     return res.status(404).send({ message: 'Application not found' });
    //   }

    //   // 2. Update status in teacher applications collection
    //   const updateAppResult = await teacherApplicationsCollection.updateOne(
    //     { _id: new ObjectId(id) },
    //     { $set: { status: 'approved' } }
    //   );

    //   // 3. Promote user role in users collection
    //   const updateUserResult = await usersCollection.updateOne(
    //     { email: application.email },
    //     { $set: { role: 'teacher' } }
    //   );

    //   res.send({ updateAppResult, updateUserResult });
    // });
    app.patch('/teacher-applications/approve/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid Application ID' });
        }

        const application = await teacherApplicationsCollection.findOne({ _id: new ObjectId(id) });
        if (!application) {
          return res.status(404).send({ message: 'Application not found' });
        }

        if (application.status === 'approved') {
          return res.status(400).send({ message: 'This application has already been approved' });
        }

        const updateAppResult = await teacherApplicationsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: 'approved' } }
        );

        const updateUserResult = await usersCollection.updateOne(
          { email: application.email },
          { $set: { role: 'teacher' } }
        );

        res.send({ updateAppResult, updateUserResult });
      } catch (error) {
        // console.error('Error approving teacher application:', error);
        res.status(500).send({ message: 'Failed to approve application', error: error.message });
      }
    });

    // ------------------------------------------------------------------
    // 5. PATCH: Reject Teacher Application (Admin Only)
    // ------------------------------------------------------------------
    app.patch('/teacher-applications/reject/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: { status: 'rejected' },
      };

      const result = await teacherApplicationsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // GET single user by email (for dashboard role checking)
    // app.get('/users/:email', verifyToken, async (req, res) => {
    //   try {
    //     const email = req.params.email;
    //     if (email !== req.decoded.email) {
    //       return res.status(403).send({ message: 'Forbidden Access' });
    //     }
    //     const query = { email: email };
    //     const user = await usersCollection.findOne(query);
    //     res.send(user || {});
    //   } catch (err) {
    //     res.status(500).send({ message: "Error fetching user details", error: err.message });
    //   }
    // });

    // PATCH: Update profile (Name and Profile Image)
    // app.patch('/users/:email', verifyToken, async (req, res) => {
    //   try {
    //     const email = req.params.email;

    //     // Security Check: Ensure decoded JWT token matches requested email
    //     if (email !== req.decoded.email) {
    //       return res.status(403).send({ message: 'Forbidden Access' });
    //     }

    //     const { name, image } = req.body;
    //     const filter = { email: email };

    //     // Dynamically build update payload based on provided fields
    //     const updatedDoc = {
    //       $set: {
    //         ...(name && { name }),
    //         ...(image && { image }),
    //         updatedAt: new Date()
    //       }
    //     };

    //     const result = await usersCollection.updateOne(filter, updatedDoc);

    //     if (result.matchedCount === 0) {
    //       return res.status(404).send({ message: 'User not found' });
    //     }

    //     res.send({
    //       success: true,
    //       message: 'Profile updated successfully',
    //       result
    //     });
    //   } catch (err) {
    //     res.status(500).send({ message: "Error updating user details", error: err.message });
    //   }
    // });

    app.patch('/users/:email', verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        if (email !== req.decoded.email) {
          return res.status(403).send({ message: 'Forbidden Access' });
        }

        const { name, photoURL } = req.body; // Changed from image to photoURL
        const filter = { email: email };

        const updatedDoc = {
          $set: {
            ...(name && { name }),
            ...(photoURL && { photoURL, image: photoURL }), // Updates both fields in MongoDB
            updatedAt: new Date()
          }
        };

        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Error updating user details", error: err.message });
      }
    });


    // ==========================================
    // USER ROUTES
    // ==========================================

    // GET: All Users
    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      // console.log(req.headers)
      try {
        const result = await usersCollection.find().toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch users", error: err.message });
      }
    });

    // POST: Create User (with initial role check)
    app.post('/users', async (req, res) => {
      try {
        const user = req.body;
        const query = { email: user.email };

        const existingUser = await usersCollection.findOne(query);
        if (existingUser) {
          return res.send({ message: 'User already exists', insertedId: null });
        }

        // Set default role to 'student' if not specified
        const userDoc = {
          ...user,
          role: user.role || 'student',
          createdAt: new Date()
        };

        const result = await usersCollection.insertOne(userDoc);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to create user", error: err.message });
      }
    });

    // DELETE: Delete User by ID
    app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await usersCollection.deleteOne(query);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to delete user", error: err.message });
      }
    });

    // PATCH: Dynamic Role Update (admin, teacher, student)
    app.patch('/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { role } = req.body; // Expecting { role: 'admin' | 'teacher' | 'student' }

        if (!role) {
          return res.status(400).send({ message: "Role is required" });
        }

        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: role
          }
        };

        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update role", error: err.message });
      }
    });

    // Backward compatibility for /users/admin/:id
    app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: { role: 'admin' }
        };
        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update admin role", error: err.message });
      }
    });

    // ==========================================
    // CARTS ROUTES
    // ==========================================

    app.get('/carts', async (req, res) => {
      const email = req.query.email;
      const query = { userEmail: email };
      const result = await cartsCollection.find(query).toArray();
      res.send(result);
    });

    app.post('/carts', verifyToken, async (req, res) => {
      const cartItem = req.body;
      const result = await cartsCollection.insertOne(cartItem);
      res.send(result);
    });

    app.delete('/carts/:id', verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await cartsCollection.deleteOne(query);
      res.send(result);
    });

    // ==========================================
    // CLASSES & REVIEWS ROUTES
    // ==========================================

    // GET: All classes
    app.get('/classes', async (req, res) => {
      try {
        const classes = await classCollection.find().toArray();

        // Look up each teacher's status in one batched query, then stamp it onto each course
        const teacherEmails = [...new Set(classes.map(c => c.teacherEmail || c.email).filter(Boolean))];
        const teachers = await usersCollection
          .find({ email: { $in: teacherEmails } }, { projection: { email: 1, status: 1 } })
          .toArray();

        const statusMap = {};
        teachers.forEach(t => { statusMap[t.email] = t.status || 'active'; });

        const enriched = classes.map(c => ({
          ...c,
          instructorStatus: statusMap[c.teacherEmail || c.email] || 'active'
        }));

        res.status(200).send(enriched);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch classes", error: err.message });
      }
    });

    // GET: Teacher specific classes (Teacher/Admin Protected)
    app.get('/classes/teacher/:email', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const email = req.params.email;
        if (email !== req.decoded.email) {
          return res.status(403).send({ message: 'Forbidden Access' });
        }
        const query = { teacherEmail: email };
        const result = await classCollection.find(query).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch teacher classes", error: err.message });
      }
    });

    // POST: Create Class (Teacher/Admin Protected)
    // POST: Create Class (Teacher/Admin Protected)
    // app.post('/classes', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
    //   try {
    //     const courseData = req.body;

    //     // Direct validation for essential fields
    //     if (!courseData.title || courseData.price === undefined) {
    //       return res.status(400).send({ message: "Title and Price are required fields." });
    //     }

    //     const classItem = {
    //       // Basic Info
    //       title: courseData.title || "",
    //       teacherId: courseData.teacherId || "",
    //       teacherEmail: req.decoded?.email || courseData.email || "", // Enforce decoded email security
    //       name: courseData.name || "",
    //       email: courseData.email || "",
    //       teacherImage: courseData.teacherImage || "",

    //       // Pricing & Details
    //       price: parseFloat(courseData.price) || 0,
    //       originalPrice: parseFloat(courseData.originalPrice) || 0,
    //       description: courseData.description || "",
    //       shortDescription: courseData.shortDescription || "",
    //       image: courseData.image || "",
    //       previewVideoUrl: courseData.previewVideoUrl || "",

    //       // Meta Specs
    //       category: courseData.category || "Web Development",
    //       duration: courseData.duration || "12 weeks",
    //       language: courseData.language || "English",
    //       skillLevel: courseData.skillLevel || "Advanced",
    //       certificate: courseData.certificate || "Yes",

    //       // Instructor Details
    //       instructorDetails: {
    //         title: courseData.instructorDetails?.title || "",
    //         bio: courseData.instructorDetails?.bio || ""
    //       },

    //       // Nested Content Arrays
    //       objectives: Array.isArray(courseData.objectives) ? courseData.objectives : [],
    //       requirements: Array.isArray(courseData.requirements) ? courseData.requirements : [],
    //       modules: Array.isArray(courseData.modules) ? courseData.modules : [],
    //       assignments: Array.isArray(courseData.assignments) ? courseData.assignments : [],

    //       // Admin & Analytics State
    //       status: 'pending', // Default status for admin review
    //       totalEnrollment: 0,
    //       totalReviews: 0,
    //       totalAssignments: courseData.assignments?.length || 0,
    //       totalLessons: courseData.modules?.reduce((acc, mod) => acc + (mod.lessons?.length || 0), 0) || 0,
    //       totalHours: parseFloat(courseData.totalHours) || 0,
    //       rating: 0,

    //       // Timestamps
    //       createdAt: new Date(),
    //       updatedAt: new Date()
    //     };

    //     const result = await classCollection.insertOne(classItem);
    //     res.status(201).send(result);
    //   } catch (err) {
    //     res.status(500).send({ message: "Failed to create class", error: err.message });
    //   }
    // });

    app.post('/classes', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const courseData = req.body;

        if (!courseData.title || courseData.price === undefined) {
          return res.status(400).send({ message: "Title and Price are required fields." });
        }

        const classItem = {
          // ... all your existing fields stay exactly as they are ...
          title: courseData.title || "",
          teacherId: courseData.teacherId || "",
          teacherEmail: req.decoded?.email || courseData.email || "",
          name: courseData.name || "",
          email: courseData.email || "",
          teacherImage: courseData.teacherImage || "",
          price: parseFloat(courseData.price) || 0,
          originalPrice: parseFloat(courseData.originalPrice) || 0,
          description: courseData.description || "",
          shortDescription: courseData.shortDescription || "",
          image: courseData.image || "",
          previewVideoUrl: courseData.previewVideoUrl || "",
          category: courseData.category || "Web Development",
          duration: courseData.duration || "12 weeks",
          language: courseData.language || "English",
          skillLevel: courseData.skillLevel || "Advanced",
          certificate: courseData.certificate || "Yes",
          instructorDetails: {
            title: courseData.instructorDetails?.title || "",
            bio: courseData.instructorDetails?.bio || ""
          },
          objectives: Array.isArray(courseData.objectives) ? courseData.objectives : [],
          requirements: Array.isArray(courseData.requirements) ? courseData.requirements : [],
          modules: Array.isArray(courseData.modules) ? courseData.modules : [],
          assignments: Array.isArray(courseData.assignments) ? courseData.assignments : [],
          status: 'pending',
          totalEnrollment: 0,
          totalReviews: 0,
          totalAssignments: courseData.assignments?.length || 0,
          totalLessons: courseData.modules?.reduce((acc, mod) => acc + (mod.lessons?.length || 0), 0) || 0,
          totalHours: parseFloat(courseData.totalHours) || 0,
          rating: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // NEW: generate semantic embedding for AI-powered related-course recommendations
        classItem.embedding = await generateCourseEmbedding(classItem);

        const result = await classCollection.insertOne(classItem);
        res.status(201).send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to create class", error: err.message });
      }
    });

    app.patch('/classes/status/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { status, rejectionReason } = req.body;

        // Validate MongoDB ObjectId
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid Class ID" });
        }

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status: status,
            rejectionReason: status === 'rejected' ? (rejectionReason || '') : '',
            updatedAt: new Date()
          }
        };

        // FIXED: Changed classesCollection -> classCollection
        const result = await classCollection.updateOne(filter, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Class not found" });
        }

        res.send(result);
      } catch (error) {
        // console.error("Server update error:", error);
        res.status(500).send({ message: "Failed to update status", error: error.message });
      }
    });

    // app.get('/my-classes/:email', verifyToken, async (req, res) => {
    //   const email = req.params.email;

    //   // Search using $or in case your DB saved it under teacherEmail or email
    //   const query = {
    //     $or: [
    //       { teacherEmail: email },
    //       { email: email }
    //     ]
    //   };

    //   const result = await classCollection.find(query).toArray();
    //   res.send(result);
    // });
    // REPLACE your current GET /my-classes/:email with this:
    app.get('/my-classes/:email', verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        // Security Check: Verify requesting user matches token email
        if (email !== req.decoded?.email) {
          return res.status(403).send({ message: 'Forbidden Access' });
        }

        const query = {
          $or: [
            { teacherEmail: email },
            { email: email }
          ]
        };

        const result = await classCollection.find(query).sort({ _id: -1 }).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch classes", error: err.message });
      }
    });

    // PATCH: Update existing Class by ID (Teacher/Admin Protected)
    // app.patch('/classes/:id', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
    //   try {
    //     const id = req.params.id;
    //     const requesterEmail = req.decoded.email;
    //     const updateData = req.body;

    //     const user = await usersCollection.findOne({ email: requesterEmail });
    //     const targetClass = await classCollection.findOne({ _id: new ObjectId(id) });

    //     if (!targetClass) {
    //       return res.status(404).send({ message: "Class not found" });
    //     }

    //     // Admins can update any class; Teachers can only update their own
    //     if (user.role !== 'admin' && targetClass.teacherEmail !== requesterEmail) {
    //       return res.status(403).send({ message: "Forbidden: You can only edit your own classes" });
    //     }

    //     const updatedDoc = {
    //       $set: {
    //         ...updateData,
    //         updatedAt: new Date()
    //       }
    //     };

    //     const result = await classCollection.updateOne({ _id: new ObjectId(id) }, updatedDoc);
    //     res.send(result);
    //   } catch (err) {
    //     res.status(500).send({ message: "Failed to update class", error: err.message });
    //   }
    // });
    // REPLACE your current PATCH /classes/:id with this fixed version:
    app.patch('/classes/:id', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const requesterEmail = req.decoded.email;
        const updateData = { ...req.body };

        // Prevent Mongo immutable field error
        delete updateData._id;

        // Prevent changing ownership fields
        delete updateData.email;
        delete updateData.teacherEmail;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid Class ID format" });
        }

        const user = await usersCollection.findOne({ email: requesterEmail });
        const targetClass = await classCollection.findOne({ _id: new ObjectId(id) });

        if (!targetClass) {
          return res.status(404).send({ message: "Class not found" });
        }

        // Authorization Guard
        if (user.role !== 'admin' && targetClass.teacherEmail !== requesterEmail && targetClass.email !== requesterEmail) {
          return res.status(403).send({ message: "Forbidden: You can only edit your own classes" });
        }

        // Recalculate metrics if modules/assignments arrays are updated
        if (updateData.modules) {
          updateData.totalLessons = updateData.modules.reduce((acc, mod) => acc + (mod.lessons?.length || 0), 0);
        }
        // if (updateData.assignments) {
        //   updateData.totalAssignments = updateData.assignments.length;
        // }

        // If any content-relevant field changed, regenerate the embedding to stay accurate
        if (
          updateData.title ||
          updateData.description ||
          updateData.shortDescription ||
          updateData.category ||
          updateData.objectives
        ) {
          const mergedForEmbedding = { ...targetClass, ...updateData };
          updateData.embedding = await generateCourseEmbedding(mergedForEmbedding);
        }

        const updatedDoc = {
          $set: {
            ...updateData,
            updatedAt: new Date()
          }
        };

        const result = await classCollection.updateOne({ _id: new ObjectId(id) }, updatedDoc);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update class", error: err.message });
      }
    });

    // DELETE: Remove Class (Teacher/Admin Protected)
    // app.delete('/classes/:id', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
    //   try {
    //     const id = req.params.id;
    //     const requesterEmail = req.decoded.email;

    //     // Fetch the requesting user to check role
    //     const user = await usersCollection.findOne({ email: requesterEmail });
    //     const targetClass = await classCollection.findOne({ _id: new ObjectId(id) });

    //     if (!targetClass) {
    //       return res.status(404).send({ message: "Class not found" });
    //     }

    //     // Admins can delete anything; Teachers can only delete their own classes
    //     if (user.role !== 'admin' && targetClass.teacherEmail !== requesterEmail) {
    //       return res.status(403).send({ message: "Forbidden: You can only delete your own classes" });
    //     }

    //     const result = await classCollection.deleteOne({ _id: new ObjectId(id) });
    //     res.send(result);
    //   } catch (err) {
    //     res.status(500).send({ message: "Failed to delete class", error: err.message });
    //   }
    // });
    // REPLACE your current DELETE /classes/:id with this:
    app.delete('/classes/:id', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const requesterEmail = req.decoded.email;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid Class ID format" });
        }

        const user = await usersCollection.findOne({ email: requesterEmail });
        const targetClass = await classCollection.findOne({ _id: new ObjectId(id) });

        if (!targetClass) {
          return res.status(404).send({ message: "Class not found" });
        }

        // Check both potential email fields
        const isOwner = targetClass.teacherEmail === requesterEmail || targetClass.email === requesterEmail;

        if (user.role !== 'admin' && !isOwner) {
          return res.status(403).send({ message: "Forbidden: You can only delete your own classes" });
        }

        const result = await classCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to delete class", error: err.message });
      }
    });

    // TeacherClassDetails

    // ==========================================
    // TEACHER CLASS DETAILS & ASSIGNMENTS ROUTES
    // ==========================================

    // GET: Class Progress Metrics
    app.get('/classes/progress/:id', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const classId = req.params.id;

        if (!ObjectId.isValid(classId)) {
          return res.status(400).send({ message: 'Invalid Class ID format' });
        }

        const classDetails = await classCollection.findOne({ _id: new ObjectId(classId) });
        if (!classDetails) {
          return res.status(404).send({ message: 'Class not found' });
        }

        const totalAssignments = await assignmentsCollection.countDocuments({ classId });
        const totalSubmissions = await submissionsCollection.countDocuments({ classId });

        const daysActive = Math.max(
          1,
          Math.ceil((new Date() - new Date(classDetails.createdAt || Date.now())) / (1000 * 60 * 60 * 24))
        );
        const perDaySubmission = Math.round(totalSubmissions / daysActive);

        res.send({
          totalEnrollment: classDetails.totalEnrollment || 0,
          totalAssignment: totalAssignments,
          perDaySubmission,
        });
      } catch (error) {
        res.status(500).send({ message: 'Error fetching class progress', error: error.message });
      }
    });

    // GET: Assignments by Class ID
    app.get('/assignments/class/:id', verifyToken, async (req, res) => {
      try {
        const classId = req.params.id;
        const assignments = await assignmentsCollection
          .find({ classId })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(assignments);
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch assignments', error: error.message });
      }
    });

    // POST: Create Assignment & Increment Count
    app.post('/assignments', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const { classId, title, description, createdAt } = req.body;

        if (!classId || !title || !description) {
          return res.status(400).send({ message: 'Missing required fields' });
        }

        if (!ObjectId.isValid(classId)) {
          return res.status(400).send({ message: 'Invalid Class ID format' });
        }

        const newAssignment = {
          classId,
          title,
          description,
          createdAt: createdAt || new Date().toISOString(),
        };

        const result = await assignmentsCollection.insertOne(newAssignment);

        await classCollection.updateOne(
          { _id: new ObjectId(classId) },
          { $inc: { totalAssignments: 1 }, $set: { updatedAt: new Date() } }
        );

        res.status(201).send({
          insertedId: result.insertedId,
          message: 'Assignment created successfully',
        });
      } catch (error) {
        res.status(500).send({ message: 'Failed to create assignment', error: error.message });
      }
    });

    // PATCH: Update an assignment's title/description (Teacher/Admin, ownership-checked)
    app.patch('/assignments/:id', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { title, description } = req.body;
        const requesterEmail = req.decoded.email;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid Assignment ID' });
        }
        if (!title?.trim() || !description?.trim()) {
          return res.status(400).send({ message: 'Title and description are required' });
        }

        const assignment = await assignmentsCollection.findOne({ _id: new ObjectId(id) });
        if (!assignment) {
          return res.status(404).send({ message: 'Assignment not found' });
        }

        // Ownership check via the parent class
        if (!ObjectId.isValid(assignment.classId)) {
          return res.status(400).send({ message: 'Assignment has an invalid class reference' });
        }
        const parentClass = await classCollection.findOne({ _id: new ObjectId(assignment.classId) });
        const requester = await usersCollection.findOne({ email: requesterEmail });
        const isOwner = parentClass?.teacherEmail === requesterEmail || parentClass?.email === requesterEmail;

        if (requester?.role !== 'admin' && !isOwner) {
          return res.status(403).send({ message: 'Forbidden: You can only edit assignments for your own classes' });
        }

        const result = await assignmentsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { title: title.trim(), description: description.trim(), updatedAt: new Date() } }
        );

        res.send({ success: true, result });
      } catch (error) {
        // console.error('Error updating assignment:', error);
        res.status(500).send({ message: 'Failed to update assignment', error: error.message });
      }
    });

    // DELETE: Remove an assignment and its submissions (Teacher/Admin, ownership-checked)
    app.delete('/assignments/:id', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const requesterEmail = req.decoded.email;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid Assignment ID' });
        }

        const assignment = await assignmentsCollection.findOne({ _id: new ObjectId(id) });
        if (!assignment) {
          return res.status(404).send({ message: 'Assignment not found' });
        }

        if (!ObjectId.isValid(assignment.classId)) {
          return res.status(400).send({ message: 'Assignment has an invalid class reference' });
        }
        const parentClass = await classCollection.findOne({ _id: new ObjectId(assignment.classId) });
        const requester = await usersCollection.findOne({ email: requesterEmail });
        const isOwner = parentClass?.teacherEmail === requesterEmail || parentClass?.email === requesterEmail;

        if (requester?.role !== 'admin' && !isOwner) {
          return res.status(403).send({ message: 'Forbidden: You can only delete assignments for your own classes' });
        }

        // NEW: check submission impact before deleting anything
        const relatedSubmissions = await submissionsCollection.find({ assignmentId: id }).toArray();
        const gradedSubmissions = relatedSubmissions.filter(s => s.status === 'graded');

        // Hard block: graded work exists — no override, protects certificate eligibility
        if (gradedSubmissions.length > 0) {
          return res.status(422).send({
            blocked: true,
            gradedSubmissions: gradedSubmissions.length,
            message: `This assignment has ${gradedSubmissions.length} graded submission(s) and cannot be deleted, since it may affect student certificate eligibility. Please contact an admin if this assignment must be removed.`
          });
        }

        // Soft warning: ungraded submissions exist — teacher can confirm and force it through
        if (relatedSubmissions.length > 0 && req.query.force !== 'true') {
          return res.status(409).send({
            requiresConfirmation: true,
            totalSubmissions: relatedSubmissions.length,
            message: `This assignment has ${relatedSubmissions.length} student(s) submission(s) that will be affected. Deleting it will permanently remove them.`
          });
        }

        // Clean up dependent submissions so they don't become orphaned records
        await submissionsCollection.deleteMany({ assignmentId: id });

        const result = await assignmentsCollection.deleteOne({ _id: new ObjectId(id) });

        // Keep the class's assignment count accurate
        await classCollection.updateOne(
          { _id: new ObjectId(assignment.classId) },
          { $inc: { totalAssignments: -1 }, $set: { updatedAt: new Date() } }
        );

        res.send({ success: true, result });
      } catch (error) {
        // console.error('Error deleting assignment:', error);
        res.status(500).send({ message: 'Failed to delete assignment', error: error.message });
      }
    });


    // GET: Dynamic stats aggregation endpoint
    // GET: Dynamic stats aggregation endpoint
    app.get('/stats', async (req, res) => {
      try {
        const totalCourses = await classCollection.countDocuments({ status: "accepted" });

        const enrollmentResult = await classCollection.aggregate([
          { $match: { status: "accepted" } },
          {
            $group: {
              _id: null,
              totalLearners: { $sum: { $ifNull: ["$totalEnrollment", 0] } },
              totalLessons: { $sum: { $ifNull: ["$totalLessons", 0] } }
            }
          }
        ]).toArray();

        const totalLearners = enrollmentResult[0]?.totalLearners || 0;
        const totalLessons = enrollmentResult[0]?.totalLessons || 0;

        const teachersList = await classCollection.aggregate([
          { $match: { status: "accepted" } },
          { $group: { _id: "$teacherId" } }
        ]).toArray();

        res.status(200).json({
          activeLearners: totalLearners,
          coursesCount: totalCourses,
          expertMentors: teachersList.length,
          totalLessons
        });
      } catch (err) {
        // console.error("Stats compilation error:", err);
        res.status(500).json({ message: "Failed to compile metrics", error: err.message });
      }
    });

    // GET: Featured instructors with live course/enrollment counts
    // GET: Featured instructors with live course/enrollment counts


    // POST: Submit a review (enrolled students only, one review per course)
    // app.post('/reviews', verifyToken, async (req, res) => {
    //   try {
    //     const { classId, rating, comment } = req.body;
    //     const userEmail = req.decoded.email;

    //     if (!classId || !rating) {
    //       return res.status(400).send({ message: 'Class ID and rating are required' });
    //     }
    //     if (!ObjectId.isValid(classId)) {
    //       return res.status(400).send({ message: 'Invalid Class ID' });
    //     }

    //     // Gate: must have a non-refunded payment covering this class
    //     const payment = await paymentCollection.findOne({
    //       userEmail,
    //       status: { $ne: 'refunded' },
    //       $or: [
    //         { 'items.classId': classId },
    //         { 'items._id': classId },
    //         { classId: classId }
    //       ]
    //     });

    //     if (!payment) {
    //       return res.status(403).send({ message: 'You must be enrolled in this course to leave a review' });
    //     }

    //     // One review per user per course
    //     const existingReview = await reviewsCollection.findOne({ classId, userEmail });
    //     if (existingReview) {
    //       return res.status(400).send({ message: 'You have already reviewed this course' });
    //     }

    //     const user = await usersCollection.findOne({ email: userEmail });

    //     const reviewDoc = {
    //       classId,
    //       userEmail,
    //       userName: user?.name || 'Student',
    //       userImage: user?.photoURL || user?.image || '',
    //       rating: Number(rating),
    //       comment: (comment || '').trim(),
    //       createdAt: new Date()
    //     };

    //     const result = await reviewsCollection.insertOne(reviewDoc);

    //     // Recalculate this class's aggregate rating + review count
    //     const allReviews = await reviewsCollection.find({ classId }).toArray();
    //     const totalReviews = allReviews.length;
    //     const avgRating = allReviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / totalReviews;

    //     if (ObjectId.isValid(classId)) {
    //       await classCollection.updateOne(
    //         { _id: new ObjectId(classId) },
    //         { $set: { rating: Number(avgRating.toFixed(2)), totalReviews } }
    //       );
    //     }

    //     res.status(201).send({
    //       success: true,
    //       insertedId: result.insertedId,
    //       message: 'Review submitted successfully'
    //     });
    //   } catch (error) {
    //     console.error('Error submitting review:', error);
    //     res.status(500).send({ message: 'Failed to submit review' });
    //   }
    // });

    // GET: Featured homepage testimonials — one per category, no repeated users, capped at 8
    app.get('/reviews/featured', async (req, res) => {
      try {
        const MAX_FEATURED = 8;

        const [allReviews, allClasses] = await Promise.all([
          reviewsCollection.find({ comment: { $exists: true, $ne: '' } })
            .sort({ rating: -1, createdAt: -1 })
            .toArray(),
          classCollection.find({}, { projection: { category: 1 } }).toArray()
        ]);

        const categoryByClassId = {};
        allClasses.forEach(c => {
          categoryByClassId[c._id.toString()] = c.category || 'General';
        });

        const seenCategories = new Set();
        const seenUsers = new Set();
        const picked = [];

        const tryPick = (allowRepeatCategory) => {
          for (const review of allReviews) {
            if (picked.length >= MAX_FEATURED) break;
            const category = categoryByClassId[review.classId?.toString()] || 'General';
            const userKey = review.userEmail || review.userName;

            if (seenUsers.has(userKey)) continue;
            if (!allowRepeatCategory && seenCategories.has(category)) continue;

            seenCategories.add(category);
            seenUsers.add(userKey);
            picked.push(review);
          }
        };

        tryPick(false); // strict pass: unique categories
        if (picked.length < MAX_FEATURED) tryPick(true); // backfill pass: allow repeat categories

        res.send(picked);
      } catch (error) {
        // console.error('Error fetching featured reviews:', error);
        res.status(500).send({ message: 'Failed to fetch featured reviews', error: error.message });
      }
    });

    app.post('/reviews', verifyToken, async (req, res) => {
      try {
        const { classId, rating, comment } = req.body;
        const userEmail = req.decoded.email;

        if (!classId || !rating) {
          return res.status(400).send({ message: 'Class ID and rating are required' });
        }
        if (!ObjectId.isValid(classId)) {
          return res.status(400).send({ message: 'Invalid Class ID' });
        }

        // Gate: must have a non-refunded payment covering this class
        const payment = await paymentCollection.findOne({
          userEmail,
          status: { $ne: 'refunded' },
          $or: [
            { 'items.classId': classId },
            { 'items._id': classId },
            { classId: classId }
          ]
        });

        if (!payment) {
          return res.status(403).send({ message: 'You must be enrolled in this course to leave a review' });
        }

        // One review per user per course
        const existingReview = await reviewsCollection.findOne({ classId, userEmail });
        if (existingReview) {
          return res.status(400).send({ message: 'You have already reviewed this course' });
        }

        const user = await usersCollection.findOne({ email: userEmail });

        // NEW: fetch the course so we can denormalize its title onto the review
        const courseDoc = await classCollection.findOne({ _id: new ObjectId(classId) });

        const reviewDoc = {
          classId,
          courseName: courseDoc?.title ? `${courseDoc.title} Graduate` : 'Course',
          userEmail,
          userName: user?.name || 'Student',
          userImage: user?.photoURL || user?.image || '',
          rating: Number(rating),
          comment: (comment || '').trim(),
          createdAt: new Date()
        };

        const result = await reviewsCollection.insertOne(reviewDoc);

        // Recalculate this class's aggregate rating + review count
        const allReviews = await reviewsCollection.find({ classId }).toArray();
        const totalReviews = allReviews.length;
        const avgRating = allReviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / totalReviews;

        await classCollection.updateOne(
          { _id: new ObjectId(classId) },
          { $set: { rating: Number(avgRating.toFixed(2)), totalReviews } }
        );

        res.status(201).send({
          success: true,
          insertedId: result.insertedId,
          message: 'Review submitted successfully'
        });
      } catch (error) {
        // console.error('Error submitting review:', error);
        res.status(500).send({ message: 'Failed to submit review' });
      }
    });

    // GET: Reviews for a specific class (public)
    app.get('/reviews/class/:classId', async (req, res) => {
      try {
        const classId = req.params.classId;
        const result = await reviewsCollection
          .find({ classId })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch reviews', error: error.message });
      }
    });

    // GET: All reviews
    app.get('/reviews', async (req, res) => {
      try {
        const result = await reviewsCollection.find().toArray();
        res.status(200).send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch reviews", error: err.message });
      }
    });

    // POST: Create Payment Intent
    // app.post('/create-payment-intent', verifyToken, async (req, res) => {
    //   try {
    //     const { price } = req.body;
    //     const numericPrice = parseFloat(price);

    //     if (!price || isNaN(numericPrice) || numericPrice <= 0) {
    //       return res.status(400).send({ error: 'Invalid or missing price amount' });
    //     }

    //     const amount = Math.round(numericPrice * 100);

    //     const paymentIntent = await stripe.paymentIntents.create({
    //       amount: amount,
    //       currency: 'usd',
    //       payment_method_types: ['card'],
    //     });

    //     res.send({ clientSecret: paymentIntent.client_secret });
    //   } catch (error) {
    //     console.error('Stripe Intent Error:', error.message);
    //     res.status(500).send({ error: error.message });
    //   }
    // });

    // POST: Record Payment, Bulk Enroll, & Clear Carts
    // app.post('/payments', verifyToken, async (req, res) => {
    //   try {
    //     const payment = req.body;
    //     const { cartIds, items, email, userName, name, transactionId, price } = payment;

    //     if (email !== req.decoded?.email) {
    //       return res.status(403).send({ message: 'Forbidden access: Email mismatch' });
    //     }

    //     if (!transactionId || !email) {
    //       return res.status(400).send({ message: 'Missing transactionId or email' });
    //     }

    //     // NEW: Block enrollment if any purchased course's teacher is deactivated
    //     if (Array.isArray(items) && items.length > 0) {
    //       for (const item of items) {
    //         const targetClassId = item.classId || item._id;
    //         if (!targetClassId) continue;

    //         const idConditions = [{ _id: targetClassId }];
    //         if (ObjectId.isValid(targetClassId)) idConditions.push({ _id: new ObjectId(targetClassId) });

    //         const courseDoc = await classCollection.findOne({ $or: idConditions });
    //         if (!courseDoc) continue;

    //         const teacherEmail = courseDoc.teacherEmail || courseDoc.email;
    //         const teacherDoc = await usersCollection.findOne({ email: teacherEmail });

    //         if (teacherDoc?.status === 'deactivated') {
    //           return res.status(403).send({
    //             message: `Enrollment is currently unavailable for "${courseDoc.title}" because the instructor's account is inactive.`
    //           });
    //         }
    //       }
    //     }

    //     const studentName = userName || name || req.decoded?.name || 'Enrolled Student';

    //     const paymentResult = await paymentCollection.insertOne({
    //       userEmail: email,
    //       userName: studentName,
    //       transactionId,
    //       price: parseFloat(price) || 0,
    //       items: items || [],
    //       cartIds: cartIds || [],
    //       paidAt: new Date(),
    //       status: 'completed'
    //     });

    //     const enrollmentDocs = [];
    //     if (Array.isArray(items) && items.length > 0) {
    //       for (const item of items) {
    //         const targetClassId = item.classId || item._id;

    //         if (targetClassId) {
    //           enrollmentDocs.push({
    //             classId: targetClassId,
    //             userEmail: email,
    //             userName: studentName,
    //             enrolledAt: new Date(),
    //             transactionId,
    //           });

    //           if (ObjectId.isValid(targetClassId)) {
    //             await classCollection.updateOne(
    //               { _id: new ObjectId(targetClassId) },
    //               { $inc: { totalEnrollment: 1 } }
    //             );
    //           }
    //         }
    //       }
    //     }

    //     let enrollmentResult = null;
    //     if (enrollmentDocs.length > 0) {
    //       enrollmentResult = await enrollmentCollection.insertMany(enrollmentDocs);
    //     }

    //     let cartResult = null;
    //     if (Array.isArray(cartIds) && cartIds.length > 0) {
    //       const validCartObjectIds = cartIds
    //         .filter((id) => ObjectId.isValid(id))
    //         .map((id) => new ObjectId(id));

    //       if (validCartObjectIds.length > 0) {
    //         cartResult = await cartsCollection.deleteMany({
    //           _id: { $in: validCartObjectIds },
    //         });
    //       }
    //     }

    //     res.send({ paymentResult, enrollmentResult, cartResult });
    //   } catch (error) {
    //     console.error('Payment processing error:', error);
    //     res.status(500).send({
    //       message: 'Failed to process payment record',
    //       error: error.message,
    //     });
    //   }
    // });

    // POST: Initialize SSLCommerz payment session
    app.post('/payment/init', verifyToken, async (req, res) => {
      try {
        const { items, totalAmount, isDirectPurchase, cartIds, phone } = req.body;
        const email = req.decoded?.email;

        if (!email) return res.status(403).send({ message: 'Forbidden access' });
        if (!items || items.length === 0 || !totalAmount || totalAmount <= 0) {
          return res.status(400).send({ message: 'Invalid checkout payload' });
        }

        const userDoc = await usersCollection.findOne({ email });
        const userName = userDoc?.name || 'EdCare Student';
        const tran_id = `EDCARE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        await pendingPaymentsCollection.insertOne({
          tran_id,
          userEmail: email,
          userName,
          items,
          cartIds: cartIds || [],
          totalAmount: Number(totalAmount),
          isDirectPurchase: Boolean(isDirectPurchase),
          status: 'pending',
          createdAt: new Date()
        });

        const sslData = {
          total_amount: Number(totalAmount),
          currency: 'BDT',
          tran_id,
          success_url: `${process.env.SERVER_URL}/payment/success`,
          fail_url: `${process.env.SERVER_URL}/payment/fail`,
          cancel_url: `${process.env.SERVER_URL}/payment/cancel`,
          ipn_url: `${process.env.SERVER_URL}/payment/ipn`,
          shipping_method: 'No',
          product_name: 'Course Enrollment',
          product_category: 'Education',
          product_profile: 'general',
          cus_name: userName,
          cus_email: email,
          cus_add1: 'Dhaka',
          cus_city: 'Dhaka',
          cus_state: 'Dhaka',
          cus_postcode: '1000',
          cus_country: 'Bangladesh',
          cus_phone: phone || '01700000000',
          ship_name: userName,
          ship_add1: 'Dhaka',
          ship_city: 'Dhaka',
          ship_state: 'Dhaka',
          ship_postcode: 1000,
          ship_country: 'Bangladesh',
        };

        const apiResponse = await sslcz.init(sslData);

        if (!apiResponse?.GatewayPageURL) {
          // console.error('SSLCommerz init failed:', apiResponse);
          return res.status(502).send({ message: 'Failed to initialize payment gateway' });
        }

        res.send({ gatewayUrl: apiResponse.GatewayPageURL });
      } catch (error) {
        // console.error('Payment init error:', error);
        res.status(500).send({ message: 'Failed to initialize payment', error: error.message });
      }
    });

    // Shared logic: actually record the payment + create enrollments (called by success and ipn)
    async function finalizePendingPayment(tran_id) {
      const pending = await pendingPaymentsCollection.findOne({ tran_id });
      if (!pending) return { ok: false, reason: 'not_found' };
      if (pending.status === 'completed') return { ok: true, alreadyProcessed: true };

      const { userEmail, userName, items, cartIds, totalAmount } = pending;
      const platformFeePercentage = await getPlatformFeePercentage();

      const paymentResult = await paymentCollection.insertOne({
        userEmail,
        userName,
        transactionId: tran_id,
        
        price: totalAmount,
        items: items || [],
        cartIds: cartIds || [],
        paidAt: new Date(),
        status: 'completed',
         platformFeePercentage
      });

      const enrollmentDocs = [];
      for (const item of items) {
        const targetClassId = item.classId || item._id;
        if (!targetClassId) continue;

        enrollmentDocs.push({
          classId: targetClassId,
          userEmail,
          userName,
          enrolledAt: new Date(),
          transactionId: tran_id,
        });

        if (ObjectId.isValid(targetClassId)) {
          await classCollection.updateOne(
            { _id: new ObjectId(targetClassId) },
            { $inc: { totalEnrollment: 1 } }
          );
        }
      }

      if (enrollmentDocs.length > 0) {
        await enrollmentCollection.insertMany(enrollmentDocs);
      }

      if (Array.isArray(cartIds) && cartIds.length > 0) {
        const validCartObjectIds = cartIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
        if (validCartObjectIds.length > 0) {
          await cartsCollection.deleteMany({ _id: { $in: validCartObjectIds } });
        }
      }

      await pendingPaymentsCollection.updateOne(
        { tran_id },
        { $set: { status: 'completed', paymentId: paymentResult.insertedId, completedAt: new Date() } }
      );

      return { ok: true, alreadyProcessed: false };
    }

    // POST: SSLCommerz redirects the customer's browser here after successful payment
    app.post('/payment/success', async (req, res) => {
      try {

        const { tran_id, val_id } = req.body || {};
        if (!tran_id || !val_id) {
          return res.redirect(`${process.env.CLIENT_URL}/dashboard/payment-history?status=fail`);
        }

        const validation = await sslcz.validate({ val_id });
        if (validation?.status !== 'VALID' && validation?.status !== 'VALIDATED') {
          return res.redirect(`${process.env.CLIENT_URL}/dashboard/payment-history?status=fail`);
        }

        await finalizePendingPayment(tran_id);
        res.redirect(`${process.env.CLIENT_URL}/dashboard/payment-history?status=success&tran_id=${tran_id}`);
      } catch (error) {
        // console.error('Payment success handler error:', error);
        res.redirect(`${process.env.CLIENT_URL}/dashboard/payment-history?status=fail`);
      }
    });

    // POST: SSLCommerz redirects here on failed payment
    app.post('/payment/fail', async (req, res) => {
      const { tran_id } = req.body;
      if (tran_id) {
        await pendingPaymentsCollection.updateOne({ tran_id }, { $set: { status: 'failed' } });
      }
      res.redirect(`${process.env.CLIENT_URL}/dashboard/payment-history?status=fail`);
    });

    // POST: SSLCommerz redirects here on cancelled payment
    app.post('/payment/cancel', async (req, res) => {
      const { tran_id } = req.body;
      if (tran_id) {
        await pendingPaymentsCollection.updateOne({ tran_id }, { $set: { status: 'cancelled' } });
      }
      res.redirect(`${process.env.CLIENT_URL}/dashboard/payment-history?status=cancel`);
    });

    // POST: server-to-server webhook — the reliable source of truth, independent of the customer's browser
    app.post('/payment/ipn', async (req, res) => {
      // console.log('IPN HIT!', req.body);
      try {
        const { tran_id, val_id } = req.body;
        if (!tran_id || !val_id) return res.status(400).send('Missing tran_id or val_id');

        const validation = await sslcz.validate({ val_id });
        if (validation?.status === 'VALID' || validation?.status === 'VALIDATED') {
          await finalizePendingPayment(tran_id);
        }
        res.status(200).send('IPN received');
      } catch (error) {
        // console.error('IPN handler error:', error);
        res.status(500).send('IPN processing failed');
      }
    });

    // GET /payments/:email - Fetch payment history for a student
    app.get('/payments/:email', verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        if (req.decoded?.email !== email) {
          return res.status(403).send({ message: 'Forbidden access' });
        }

        const query = { userEmail: email };
        const result = await paymentCollection
          .find(query)
          .sort({ paidAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        // console.error('Error fetching payment history:', error);
        res.status(500).send({ message: 'Internal server error' });
      }
    });



    // ==========================================
    // 1. GET TEACHER EARNINGS & STRIPE STATUS
    // ==========================================
    // ==========================================
    // 1. GET TEACHER EARNINGS & STRIPE STATUS
    // ==========================================
    // app.get('/teacher/earnings/:email', verifyToken, async (req, res) => {
    //   try {
    //     const email = req.params.email;

    //     if (req.decoded?.email !== email) {
    //       return res.status(403).send({ message: 'Forbidden access' });
    //     }

    //     // 1. Fetch Teacher Info & Stripe Status
    //     const teacherUser = await usersCollection.findOne({ email });
    //     const hasPayoutMethod = Boolean(teacherUser?.payoutMethod?.number);
    //     const payoutMethod = teacherUser?.payoutMethod || null;

    //     // 2. Fetch Teacher's Classes
    //     const classes = await classCollection.find({
    //       $or: [{ teacherEmail: email }, { email: email }]
    //     }).toArray();

    //     const classIds = classes.map(c => c._id.toString());

    //     // 3. Fetch Payments
    //     const payments = await paymentCollection.find({
    //       status: { $in: ['completed', 'paid', 'Completed', 'Paid'] },
    //       $or: [
    //         { "items.classId": { $in: classIds } },
    //         { "items._id": { $in: classIds } },
    //         { classId: { $in: classIds } }
    //       ]
    //     }).toArray();

    //     // Initialize map for per-class metrics
    //     const courseSalesMap = {};
    //     classes.forEach(c => {
    //       const cId = c._id.toString();
    //       courseSalesMap[cId] = {
    //         _id: c._id,
    //         title: c.title || c.className || c.courseName || 'Untitled Course',
    //         price: Number(c.price || 0),
    //         enrolled: 0,
    //         grossSales: 0,
    //         netRevenue: 0
    //       };
    //     });

    //     let totalGross = 0;

    //     // 4. Calculate Sales Breakdown safely
    //     payments.forEach(payment => {
    //       // Handle cart payments vs single item payments
    //       if (Array.isArray(payment.items) && payment.items.length > 0) {
    //         payment.items.forEach(item => {
    //           const itemId = (item.classId || item._id)?.toString();
    //           if (itemId && courseSalesMap[itemId]) {
    //             const itemPrice = Number(item.price || 0);
    //             courseSalesMap[itemId].grossSales += itemPrice;
    //             courseSalesMap[itemId].enrolled += 1;
    //             totalGross += itemPrice;
    //           }
    //         });
    //       } else {
    //         const cId = payment.classId?.toString();
    //         if (cId && courseSalesMap[cId]) {
    //           const amount = Number(payment.price || payment.amount || 0);
    //           courseSalesMap[cId].grossSales += amount;
    //           courseSalesMap[cId].enrolled += 1;
    //           totalGross += amount;
    //         }
    //       }
    //     });

    //     const PLATFORM_FEE_PERCENTAGE = 0.10;
    //     const platformFee = totalGross * PLATFORM_FEE_PERCENTAGE;
    //     const netEarningsTotal = totalGross - platformFee;

    //     // Build per-course output array
    //     const courses = Object.values(courseSalesMap).map(course => ({
    //       ...course,
    //       grossSales: Number(course.grossSales.toFixed(2)),
    //       netRevenue: Number((course.grossSales * (1 - PLATFORM_FEE_PERCENTAGE)).toFixed(2))
    //     }));

    //     // 5. Query Payouts
    //     const allPayouts = await payoutCollection
    //       .find({ teacherEmail: email })
    //       .sort({ createdAt: -1 })
    //       .toArray();

    //     const completedPayouts = allPayouts.filter(p =>
    //       ["Completed", "completed", "COMPLETED"].includes(p.status)
    //     );

    //     const totalPaidOut = completedPayouts.reduce((acc, p) => acc + Number(p.amount || 0), 0);
    //     const availableNetBalance = Math.max(0, netEarningsTotal - totalPaidOut);

    //     res.send({
    //       hasPayoutMethod,
    //       payoutMethod,
    //       availableNetBalance: Number(availableNetBalance.toFixed(2)),
    //       netEarningsTotal: Number(netEarningsTotal.toFixed(2)),
    //       totalGross: Number(totalGross.toFixed(2)),
    //       platformFee: Number(platformFee.toFixed(2)),
    //       totalPaidOut: Number(totalPaidOut.toFixed(2)),
    //       courses,
    //       payouts: allPayouts
    //     });
    //   } catch (error) {
    //     // console.error('Error calculating teacher earnings:', error);
    //     res.status(500).send({ message: 'Error calculating teacher earnings' });
    //   }
    // });
app.get('/teacher/earnings/:email', verifyToken, async (req, res) => {
  try {
    const email = req.params.email;

    if (req.decoded?.email !== email) {
      return res.status(403).send({ message: 'Forbidden access' });
    }

    const teacherUser = await usersCollection.findOne({ email });
    const hasPayoutMethod = Boolean(teacherUser?.payoutMethod?.number);
    const payoutMethod = teacherUser?.payoutMethod || null;

    const classes = await classCollection.find({
      $or: [{ teacherEmail: email }, { email: email }]
    }).toArray();

    const classIds = classes.map(c => c._id.toString());

    const payments = await paymentCollection.find({
      status: { $in: ['completed', 'paid', 'Completed', 'Paid'] },
      $or: [
        { "items.classId": { $in: classIds } },
        { "items._id": { $in: classIds } },
        { classId: { $in: classIds } }
      ]
    }).toArray();

    const courseSalesMap = {};
    classes.forEach(c => {
      const cId = c._id.toString();
      courseSalesMap[cId] = {
        _id: c._id,
        title: c.title || c.className || c.courseName || 'Untitled Course',
        price: Number(c.price || 0),
        enrolled: 0,
        grossSales: 0,
        netRevenue: 0
      };
    });

    let totalGross = 0;
    let totalPlatformFee = 0; // NEW: accumulated using each payment's own locked-in rate

    const currentDefaultFee = await getPlatformFeePercentage(); // fallback for legacy records without a stored rate

    payments.forEach(payment => {
      // NEW: use the rate stored on the payment; fall back to current default for old records created before this feature existed
      const feeRate = typeof payment.platformFeePercentage === 'number'
        ? payment.platformFeePercentage
        : currentDefaultFee;

      if (Array.isArray(payment.items) && payment.items.length > 0) {
        payment.items.forEach(item => {
          const itemId = (item.classId || item._id)?.toString();
          if (itemId && courseSalesMap[itemId]) {
            const itemPrice = Number(item.price || 0);
            const itemNet = itemPrice * (1 - feeRate);

            courseSalesMap[itemId].grossSales += itemPrice;
            courseSalesMap[itemId].netRevenue += itemNet; // NEW: accumulate net per-item using its own rate
            courseSalesMap[itemId].enrolled += 1;

            totalGross += itemPrice;
            totalPlatformFee += itemPrice * feeRate;
          }
        });
      } else {
        const cId = payment.classId?.toString();
        if (cId && courseSalesMap[cId]) {
          const amount = Number(payment.price || payment.amount || 0);
          const amountNet = amount * (1 - feeRate);

          courseSalesMap[cId].grossSales += amount;
          courseSalesMap[cId].netRevenue += amountNet;
          courseSalesMap[cId].enrolled += 1;

          totalGross += amount;
          totalPlatformFee += amount * feeRate;
        }
      }
    });

    const platformFee = totalPlatformFee;
    const netEarningsTotal = totalGross - platformFee;

    // NEW: courses array now uses the accumulated netRevenue directly (no single flat rate applied at the end)
    const courses = Object.values(courseSalesMap).map(course => ({
      ...course,
      grossSales: Number(course.grossSales.toFixed(2)),
      netRevenue: Number(course.netRevenue.toFixed(2))
    }));

    const allPayouts = await payoutCollection
      .find({ teacherEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    const completedPayouts = allPayouts.filter(p =>
      ["Completed", "completed", "COMPLETED"].includes(p.status)
    );

    const totalPaidOut = completedPayouts.reduce((acc, p) => acc + Number(p.amount || 0), 0);
    const availableNetBalance = Math.max(0, netEarningsTotal - totalPaidOut);

    res.send({
      hasPayoutMethod,
      payoutMethod,
      availableNetBalance: Number(availableNetBalance.toFixed(2)),
      netEarningsTotal: Number(netEarningsTotal.toFixed(2)),
      totalGross: Number(totalGross.toFixed(2)),
      platformFee: Number(platformFee.toFixed(2)),
      totalPaidOut: Number(totalPaidOut.toFixed(2)),
      currentPlatformFeePercentage: currentDefaultFee, // NEW: so the UI can show "current rate" even though past sales may differ
      courses,
      payouts: allPayouts
    });
  } catch (error) {
    res.status(500).send({ message: 'Error calculating teacher earnings' });
  }
});


    // ==========================================
    // 2. CREATE STRIPE CONNECT ONBOARDING LINK
    // ==========================================
    // ==========================================
    // CREATE STRIPE CONNECT ONBOARDING LINK
    // ==========================================


    // ==========================================
    // 3. EXECUTE STRIPE TRANSFER PAYOUT
    // ==========================================
    // app.post('/teacher/payouts/request/:email', verifyToken, async (req, res) => {
    //   try {
    //     const { email } = req.params;
    //     if (req.decoded?.email !== email) {
    //       return res.status(403).send({ message: 'Forbidden access' });
    //     }

    //     const { amount } = req.body;
    //     const numericAmount = parseFloat(amount);

    //     if (!numericAmount || numericAmount <= 0) {
    //       return res.status(400).send({ success: false, message: 'Invalid payout amount.' });
    //     }

    //     const teacherUser = await usersCollection.findOne({ email });
    //     if (!teacherUser?.stripeAccountId) {
    //       return res.status(400).send({
    //         success: false,
    //         message: 'No linked Stripe Account found. Please connect Stripe first.'
    //       });
    //     }

    //     const transfer = await stripe.transfers.create({
    //       amount: Math.round(numericAmount * 100),
    //       currency: 'usd',
    //       destination: teacherUser.stripeAccountId,
    //       description: `Earnings payout for ${email} (after platform fee)`,
    //     });

    //     const payoutRecord = {
    //       payoutId: `PO-${Date.now()}`,
    //       stripeTransferId: transfer.id,
    //       teacherEmail: email,
    //       amount: numericAmount,
    //       method: 'Stripe Instant Transfer',
    //       status: 'Completed',
    //       createdAt: new Date(),
    //       date: new Date().toISOString()
    //     };

    //     await payoutCollection.insertOne(payoutRecord);
    //     res.send({ success: true, payoutRecord });
    //   } catch (error) {
    //     console.error('Stripe Transfer failed:', error);
    //     res.status(500).send({ success: false, message: error.message });
    //   }
    // });

    //     app.post('/teacher/payouts/request/:email', verifyToken, async (req, res) => {
    //   try {
    //     const { email } = req.params;
    //     if (req.decoded?.email !== email) {
    //       return res.status(403).send({ message: 'Forbidden access' });
    //     }

    //     const { amount } = req.body;
    //     const numericAmount = parseFloat(amount);

    //     if (!numericAmount || numericAmount <= 0) {
    //       return res.status(400).send({ success: false, message: 'Invalid payout amount.' });
    //     }

    //     const teacherUser = await usersCollection.findOne({ email });
    //     if (!teacherUser?.payoutMethod?.accountNumber) {
    //       return res.status(400).send({
    //         success: false,
    //         message: 'Please add your bKash/bank payout details before requesting a payout.'
    //       });
    //     }

    //     const payoutRecord = {
    //       payoutId: `PO-${Date.now()}`,
    //       teacherEmail: email,
    //       amount: numericAmount,
    //       method: teacherUser.payoutMethod.method,
    //       accountNumber: teacherUser.payoutMethod.accountNumber,
    //       accountName: teacherUser.payoutMethod.accountName,
    //       status: 'Pending', // admin manually processes this, then marks Completed
    //       createdAt: new Date(),
    //       date: new Date().toISOString()
    //     };

    //     await payoutCollection.insertOne(payoutRecord);
    //     res.send({ success: true, payoutRecord });
    //   } catch (error) {
    //     console.error('Payout request failed:', error);
    //     res.status(500).send({ success: false, message: error.message });
    //   }
    // });

    app.post('/teacher/payouts/request/:email', verifyToken, async (req, res) => {
      try {
        const { email } = req.params;
        if (req.decoded?.email !== email) {
          return res.status(403).send({ message: 'Forbidden access' });
        }

        const { amount } = req.body;
        const numericAmount = parseFloat(amount);
        if (!numericAmount || numericAmount <= 0) {
          return res.status(400).send({ success: false, message: 'Invalid payout amount.' });
        }

        const teacherUser = await usersCollection.findOne({ email });
        if (!teacherUser?.payoutMethod?.number) {
          return res.status(400).send({
            success: false,
            message: 'Please add your bKash number before requesting a payout.'
          });
        }

        const payoutRecord = {
          payoutId: `PO-${Date.now()}`,
          teacherEmail: email,
          teacherName: teacherUser.name || 'Teacher',
          amount: numericAmount,
          method: 'bKash',
          bkashNumber: teacherUser.payoutMethod.number,
          accountName: teacherUser.payoutMethod.accountName,
          status: 'Pending',
          createdAt: new Date(),
          date: new Date().toISOString()
        };

        await payoutCollection.insertOne(payoutRecord);
        res.send({ success: true, payoutRecord, message: 'Payout request submitted. An admin will process it via bKash shortly.' });
      } catch (error) {
        // console.error('Payout request failed:', error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    app.get('/admin/payouts/pending', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await payoutCollection.find({ status: 'Pending' }).sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch pending payouts', error: error.message });
      }
    });

    // app.patch('/admin/payouts/:id/complete', verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const { id } = req.params;
    //     if (!ObjectId.isValid(id)) {
    //       return res.status(400).send({ message: 'Invalid Payout ID' });
    //     }

    //     const result = await payoutCollection.updateOne(
    //       { _id: new ObjectId(id) },
    //       { $set: { status: 'Completed', completedAt: new Date() } }
    //     );

    //     res.send({ success: true, result });
    //   } catch (error) {
    //     res.status(500).send({ message: 'Failed to complete payout', error: error.message });
    //   }
    // });


    // PATCH: Set or update teacher's bKash payout details
    // GET: All payout requests (Admin only)
    app.get('/admin/payouts', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await payoutCollection.find().sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch payouts', error: error.message });
      }
    });

    // PATCH: Mark a payout as completed, with the actual bKash transaction ID
    app.patch('/admin/payouts/:id/complete', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { bkashTrxId } = req.body;

        if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid payout ID' });
        if (!bkashTrxId?.trim()) return res.status(400).send({ message: 'bKash transaction ID is required' });

        const result = await payoutCollection.updateOne(
          { _id: new ObjectId(id), status: 'Pending' },
          { $set: { status: 'Completed', bkashTrxId: bkashTrxId.trim(), completedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res.status(400).send({ message: 'Payout not found or already processed' });
        }

        res.send({ success: true, message: 'Payout marked as completed' });
      } catch (error) {
        res.status(500).send({ message: 'Failed to update payout', error: error.message });
      }
    });

    // PATCH: Reject a pending payout request
    app.patch('/admin/payouts/:id/reject', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid payout ID' });

        const result = await payoutCollection.updateOne(
          { _id: new ObjectId(id), status: 'Pending' },
          { $set: { status: 'Rejected', rejectionReason: reason || 'Not specified', rejectedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res.status(400).send({ message: 'Payout not found or already processed' });
        }

        res.send({ success: true, message: 'Payout request rejected' });
      } catch (error) {
        res.status(500).send({ message: 'Failed to reject payout', error: error.message });
      }
    });

    app.patch('/teacher/payout-method/:email', verifyToken, async (req, res) => {
      try {
        const { email } = req.params;
        if (req.decoded?.email !== email) {
          return res.status(403).send({ message: 'Forbidden access' });
        }

        const { bkashNumber, accountName } = req.body;
        if (!bkashNumber?.trim() || !accountName?.trim()) {
          return res.status(400).send({ message: 'bKash number and account name are required' });
        }

        const bkashRegex = /^01[3-9]\d{8}$/;
        if (!bkashRegex.test(bkashNumber.trim())) {
          return res.status(400).send({ message: 'Please enter a valid 11-digit bKash number (e.g. 01712345678)' });
        }

        await usersCollection.updateOne(
          { email },
          { $set: { payoutMethod: { provider: 'bkash', number: bkashNumber.trim(), accountName: accountName.trim() }, updatedAt: new Date() } }
        );

        res.send({ success: true, message: 'Payout method saved' });
      } catch (error) {
        res.status(500).send({ message: 'Failed to save payout method', error: error.message });
      }
    });



    // ==========================================
    // 4. GET USER ROLE & DETAILS
    // ==========================================
    // app.get('/users/:email', verifyToken, async (req, res) => {
    //   const email = req.params.email;
    //   if (email !== req.decoded.email) {
    //     return res.status(403).send({ message: 'Forbidden access' });
    //   }
    //   const query = { email: email };
    //   const user = await usersCollection.findOne(query);
    //   res.send(user || { role: 'student' });
    // });

    // PATCH: Activate or Deactivate a user (Admin only)
    app.patch('/users/status/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body; // expected: 'active' | 'deactivated'

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid User ID' });
        }
        if (!['active', 'deactivated'].includes(status)) {
          return res.status(400).send({ message: "Status must be 'active' or 'deactivated'" });
        }

        const targetUser = await usersCollection.findOne({ _id: new ObjectId(id) });
        if (!targetUser) {
          return res.status(404).send({ message: 'User not found' });
        }

        // Safety guard: prevent an admin from deactivating themselves
        if (targetUser.email === req.decoded.email && status === 'deactivated') {
          return res.status(400).send({ message: 'You cannot deactivate your own account' });
        }

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } }
        );

        res.send({ success: true, result, message: `User ${status === 'deactivated' ? 'deactivated' : 'reactivated'} successfully` });
      } catch (error) {
        // console.error('Error updating user status:', error);
        res.status(500).send({ message: 'Failed to update user status', error: error.message });
      }
    });

    app.get('/users/:email', verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        if (email !== req.decoded?.email) {
          return res.status(403).send({ message: 'Forbidden access' });
        }

        const query = { email: email };
        const user = await usersCollection.findOne(query);

        // Returns user data if found, or defaults to student role fallback
        res.send(user || { role: 'student' });
      } catch (err) {
        // console.error("Error fetching user details:", err);
        res.status(500).send({ message: "Error fetching user details", error: err.message });
      }
    });

    app.get('/admin/analytics/revenue', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const days = parseInt(req.query.days) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const result = await paymentCollection.aggregate([
          {
            $match: {
              status: { $in: ['completed', 'paid'] },
              paidAt: { $gte: startDate }
            }
          },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } },
              revenue: { $sum: { $ifNull: ['$price', 0] } }
            }
          },
          { $sort: { _id: 1 } }
        ]).toArray();

        res.send(result.map(r => ({ date: r._id, revenue: Number(r.revenue.toFixed(2)) })));
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch revenue analytics', error: error.message });
      }
    });

    app.get('/admin/analytics/enrollments-by-category', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await classCollection.aggregate([
          { $match: { status: 'accepted' } },
          {
            $group: {
              _id: { $ifNull: ['$category', 'Uncategorized'] },
              enrollments: { $sum: { $ifNull: ['$totalEnrollment', 0] } }
            }
          },
          { $sort: { enrollments: -1 } }
        ]).toArray();

        res.send(result.map(r => ({ category: r._id, enrollments: r.enrollments })));
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch category analytics', error: error.message });
      }
    });

    app.get('/admin/analytics/course-status', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await classCollection.aggregate([
          {
            $group: {
              _id: { $ifNull: ['$status', 'pending'] },
              count: { $sum: 1 }
            }
          }
        ]).toArray();

        res.send(result.map(r => ({ status: r._id, count: r.count })));
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch course status analytics', error: error.message });
      }
    });

    // =========================================================================
    // GET /admin/financials
    // Unified platform revenue summary, stats, and transaction ledger
    // =========================================================================
    // app.get('/admin/financials', verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const payments = await paymentCollection.find({}).toArray();

    //     // Fetch payouts directly from payouts collection
    //     const payouts = await payoutCollection.find({}).toArray();

    //     // Safely filter completed status ignoring case and trailing spaces
    //     const completedPayouts = payouts.filter(p =>
    //       String(p.status || '').trim().toLowerCase() === 'completed'
    //     );

    //     const totalPaidOutToTeachers = completedPayouts.reduce(
    //       (acc, p) => acc + Number(p.amount || 0), 0
    //     );

    //     let grossPlatformSales = 0;
    //     let totalRefunded = 0;

    //     payments.forEach((payment) => {
    //       const amount = Number(payment.amount || payment.price || payment.totalPrice || 0);
    //       const status = String(payment.status || '').toLowerCase().trim();

    //       if (status === 'refunded') {
    //         totalRefunded += amount;
    //       } else if (['completed', 'paid', 'refund_pending', 'refund pending'].includes(status)) {
    //         grossPlatformSales += amount;
    //       }
    //     });

    //     const PLATFORM_FEE_PERCENTAGE = 0.10;
    //     const platformCommission = grossPlatformSales * PLATFORM_FEE_PERCENTAGE;

    //     const formattedPaidOut = Number(totalPaidOutToTeachers.toFixed(2));
    //     const formattedGross = Number(grossPlatformSales.toFixed(2));
    //     const formattedCommission = Number(platformCommission.toFixed(2));
    //     const formattedRefunded = Number(totalRefunded.toFixed(2));

    //     res.send({
    //       success: true,
    //       stats: {
    //         totalGrossSales: formattedGross,
    //         totalRefunded: formattedRefunded,
    //         platformCommission: formattedCommission,
    //         totalPaidOut: formattedPaidOut,
    //         totalPaidOutToTeachers: formattedPaidOut // Provided for fallback
    //       },
    //       grossPlatformSales: formattedGross,
    //       platformCommission: formattedCommission,
    //       totalPaidOutToTeachers: formattedPaidOut,
    //       totalPaidOut: formattedPaidOut, // Provided for fallback
    //       totalRefunded: formattedRefunded,
    //       payments
    //     });
    //   } catch (error) {
    //     // console.error("Admin Financials Error:", error);
    //     res.status(500).send({ success: false, message: 'Error fetching financial metrics' });
    //   }
    // });

    app.get('/admin/financials', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const payments = await paymentCollection.find({}).toArray();
    const payouts = await payoutCollection.find({}).toArray();

    const completedPayouts = payouts.filter(p =>
      String(p.status || '').trim().toLowerCase() === 'completed'
    );

    const totalPaidOutToTeachers = completedPayouts.reduce(
      (acc, p) => acc + Number(p.amount || 0), 0
    );

    const currentDefaultFee = await getPlatformFeePercentage(); // NEW

    let grossPlatformSales = 0;
    let totalRefunded = 0;
    let platformCommission = 0; // NEW: now accumulated per-payment

    payments.forEach((payment) => {
      const amount = Number(payment.amount || payment.price || payment.totalPrice || 0);
      const status = String(payment.status || '').toLowerCase().trim();
      const feeRate = typeof payment.platformFeePercentage === 'number'
        ? payment.platformFeePercentage
        : currentDefaultFee;

      if (status === 'refunded') {
        totalRefunded += amount;
      } else if (['completed', 'paid', 'refund_pending', 'refund pending'].includes(status)) {
        grossPlatformSales += amount;
        platformCommission += amount * feeRate; // NEW
      }
    });

    const formattedPaidOut = Number(totalPaidOutToTeachers.toFixed(2));
    const formattedGross = Number(grossPlatformSales.toFixed(2));
    const formattedCommission = Number(platformCommission.toFixed(2));
    const formattedRefunded = Number(totalRefunded.toFixed(2));

    res.send({
      success: true,
      stats: {
        totalGrossSales: formattedGross,
        totalRefunded: formattedRefunded,
        platformCommission: formattedCommission,
        totalPaidOut: formattedPaidOut,
        totalPaidOutToTeachers: formattedPaidOut
      },
      grossPlatformSales: formattedGross,
      platformCommission: formattedCommission,
      totalPaidOutToTeachers: formattedPaidOut,
      totalPaidOut: formattedPaidOut,
      totalRefunded: formattedRefunded,
      currentPlatformFeePercentage: currentDefaultFee, // NEW
      payments
    });
  } catch (error) {
    res.status(500).send({ success: false, message: 'Error fetching financial metrics' });
  }
});

    // =========================================================================
    // 2. GET /admin/transactions/all
    // Overall audit log of all student payments and payouts across all users
    // =========================================================================
    // =========================================================================
    app.get('/admin/transactions/all', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const payments = await paymentCollection.find({}).sort({ createdAt: -1, date: -1 }).toArray();

        const formattedPayments = payments.map(p => {
          const rawAmount = p.amount ?? p.price ?? p.totalPrice ?? p.pricePaid ?? 0;
          const numAmount = Number(rawAmount);

          const userEmail = p.userEmail || p.email || p.customerEmail || p.metadata?.userEmail || p.user?.email || 'Guest / Test User';

          let courseTitle = '';
          if (typeof p.courseTitle === 'string' && p.courseTitle.trim() && p.courseTitle !== 'N/A') {
            courseTitle = p.courseTitle;
          } else if (typeof p.title === 'string' && p.title.trim() && p.title !== 'N/A') {
            courseTitle = p.title;
          } else if (typeof p.className === 'string' && p.className.trim() && p.className !== 'N/A') {
            courseTitle = p.className;
          } else if (typeof p.courseName === 'string' && p.courseName.trim() && p.courseName !== 'N/A') {
            courseTitle = p.courseName;
          } else if (p.metadata?.courseTitle || p.metadata?.title || p.metadata?.className) {
            courseTitle = p.metadata.courseTitle || p.metadata.title || p.metadata.className;
          } else if (Array.isArray(p.items) && p.items.length > 0) {
            courseTitle = p.items.map(i => i.title || i.courseTitle || i.name).filter(Boolean).join(', ');
          } else if (Array.isArray(p.courses) && p.courses.length > 0) {
            courseTitle = p.courses.map(c => (typeof c === 'object' ? c.title || c.courseTitle || c.name : c)).filter(Boolean).join(', ');
          }

          const rawDate = p.date || p.createdAt || p.paymentDate || p.timestamp || p._id?.getTimestamp?.();
          let isoDate = new Date().toISOString();
          if (rawDate) {
            const timestamp = typeof rawDate === 'number' && rawDate < 10000000000 ? rawDate * 1000 : rawDate;
            const parsedDate = new Date(timestamp);
            if (!isNaN(parsedDate.getTime())) {
              isoDate = parsedDate.toISOString();
            }
          }

          return {
            _id: p._id,
            transactionId: p.transactionId || p.stripePaymentIntentId || p.paymentIntentId || p._id?.toString(),
            stripePaymentIntentId: p.stripePaymentIntentId || p.paymentIntentId || p.transactionId,
            userEmail,
            courseTitle: courseTitle || 'General Course Enrollment',
            amount: isNaN(numAmount) ? 0 : numAmount,
            currency: (p.currency || 'usd').toUpperCase(),
            status: p.status ? p.status.charAt(0).toUpperCase() + p.status.slice(1).toLowerCase() : 'Completed',
            date: isoDate
          };
        });

        res.send({ success: true, transactions: formattedPayments });
      } catch (error) {
        // console.error('Error fetching admin transactions:', error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // etao last time a change krsilm
    // app.patch('/refunds/approve/:id', verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const refundId = req.params.id;
    //     const refundDoc = await refundCollection.findOne({ _id: new ObjectId(refundId) });

    //     if (!refundDoc) {
    //       return res.status(404).send({ message: 'Refund request not found' });
    //     }

    //     const { classId, userEmail, transactionId, amount } = refundDoc;

    //     // 1. Update Refund Request Status
    //     await refundCollection.updateOne(
    //       { _id: new ObjectId(refundId) },
    //       { $set: { status: 'approved', processedAt: new Date() } }
    //     );

    //     // 2. Update Payment Record Status to 'refunded' (Excludes it from Total Revenue calculations)
    //     if (transactionId) {
    //       await paymentCollection.updateOne(
    //         { transactionId: transactionId },
    //         { $set: { status: 'refunded' } }
    //       );
    //     } else {
    //       await paymentCollection.updateOne(
    //         { userEmail: userEmail, 'items.classId': classId, status: 'completed' },
    //         { $set: { status: 'refunded' } }
    //       );
    //     }

    //     // 3. Remove or update Enrollment Status
    //     await enrollmentCollection.deleteOne({
    //       classId: classId,
    //       userEmail: userEmail
    //     });

    //     // 4. Decrement Total Enrollment Count on the Class
    //     if (ObjectId.isValid(classId)) {
    //       await classCollection.updateOne(
    //         { _id: new ObjectId(classId) },
    //         { $inc: { totalEnrollment: -1 } }
    //       );
    //     }

    //     res.send({ success: true, message: 'Refund approved and dashboard updated successfully.' });
    //   } catch (error) {
    //     console.error('Error approving refund:', error);
    //     res.status(500).send({ message: 'Failed to process refund approval' });
    //   }
    // });

    // =========================================================================
    // 1. POST /admin/payments/refund (Direct Admin Refund)
    // =========================================================================
    // app.post('/admin/payments/refund', verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const { paymentIntentId, transactionId, reason } = req.body;

    //     if (!paymentIntentId && !transactionId) {
    //       return res.status(400).send({ success: false, message: 'Missing transaction/payment identifiers.' });
    //     }

    //     const queryConditions = [];
    //     if (paymentIntentId) queryConditions.push({ stripePaymentIntentId: paymentIntentId }, { paymentIntentId });
    //     if (transactionId) {
    //       queryConditions.push({ transactionId });
    //       if (ObjectId.isValid(transactionId)) {
    //         queryConditions.push({ _id: new ObjectId(transactionId) });
    //       }
    //     }

    //     const payment = await paymentCollection.findOne({ $or: queryConditions });
    //     if (!payment) {
    //       return res.status(404).send({ success: false, message: 'Payment record not found.' });
    //     }

    //     if (payment.status === 'refunded') {
    //       return res.status(400).send({ success: false, message: 'Payment is already refunded.' });
    //     }

    //     let refund = null;
    //     const targetIntent = paymentIntentId || transactionId || payment.stripePaymentIntentId || payment.transactionId;

    //     if (targetIntent && targetIntent.startsWith('pi_')) {
    //       try {
    //         // Attempt refund with transfer reversals first (for Stripe Connect payments)
    //         refund = await stripe.refunds.create({
    //           payment_intent: targetIntent,
    //           reason: reason || 'requested_by_customer',
    //           reverse_transfer: true,
    //           refund_application_fee: true
    //         });
    //       } catch (stripeErr) {
    //         // Fallback: If no associated transfer exists, perform a standard Stripe refund
    //         if (stripeErr.message.includes('associated transfer') || stripeErr.message.includes('application fee')) {
    //           try {
    //             refund = await stripe.refunds.create({
    //               payment_intent: targetIntent,
    //               reason: reason || 'requested_by_customer'
    //             });
    //           } catch (fallbackErr) {
    //             console.error('Stripe fallback refund failed:', fallbackErr.message);
    //             return res.status(502).send({ success: false, message: `Stripe rejected refund: ${fallbackErr.message}` });
    //           }
    //         } else {
    //           console.error('Stripe refund failed:', stripeErr.message);
    //           return res.status(502).send({ success: false, message: `Stripe rejected refund: ${stripeErr.message}` });
    //         }
    //       }
    //     }

    //     // 1. Update Payment Status to lowercase 'refunded'
    //     await paymentCollection.updateOne(
    //       { _id: payment._id },
    //       {
    //         $set: {
    //           status: 'refunded',
    //           refundId: refund ? refund.id : `REF-${Date.now()}`,
    //           refundedAt: new Date().toISOString(),
    //           refundReason: reason || 'Admin initiated refund'
    //         }
    //       }
    //     );

    //     // 2. Revoke Course Access & Adjust Counter
    //     const classIds = Array.isArray(payment.items) && payment.items.length > 0
    //       ? payment.items.map(i => (i.classId || i._id)?.toString()).filter(Boolean)
    //       : (payment.classId ? [payment.classId.toString()] : []);

    //     if (classIds.length > 0) {
    //       await enrollmentCollection.deleteMany({
    //         userEmail: payment.userEmail,
    //         classId: { $in: classIds }
    //       });

    //       for (const cid of classIds) {
    //         if (ObjectId.isValid(cid)) {
    //           await classCollection.updateOne(
    //             { _id: new ObjectId(cid), totalEnrollment: { $gt: 0 } },
    //             { $inc: { totalEnrollment: -1 } }
    //           );
    //         }
    //       }
    //     }

    //     res.send({
    //       success: true,
    //       message: 'Refund issued and enrollments revoked successfully.',
    //       refundId: refund ? refund.id : null
    //     });
    //   } catch (error) {
    //     console.error('Stripe Refund error:', error);
    //     res.status(500).send({ success: false, message: error.message });
    //   }
    // });

    // app.post('/admin/payments/refund', verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const { paymentIntentId, transactionId, reason } = req.body;

    //     if (!paymentIntentId && !transactionId) {
    //       return res.status(400).send({ success: false, message: 'Missing transaction/payment identifiers.' });
    //     }

    //     const queryConditions = [];
    //     if (paymentIntentId) queryConditions.push({ stripePaymentIntentId: paymentIntentId }, { paymentIntentId });
    //     if (transactionId) {
    //       queryConditions.push({ transactionId });
    //       if (ObjectId.isValid(transactionId)) {
    //         queryConditions.push({ _id: new ObjectId(transactionId) });
    //       }
    //     }

    //     const payment = await paymentCollection.findOne({ $or: queryConditions });
    //     if (!payment) {
    //       return res.status(404).send({ success: false, message: 'Payment record not found.' });
    //     }

    //     if (payment.status === 'refunded') {
    //       return res.status(400).send({ success: false, message: 'Payment is already refunded.' });
    //     }

    //     let refund = null;
    //     const targetIntent = paymentIntentId || transactionId || payment.stripePaymentIntentId || payment.transactionId;

    //     // Map custom reason string to Stripe's strict allowed enum
    //     const validStripeReasons = ['duplicate', 'fraudulent', 'requested_by_customer'];
    //     const stripeReason = validStripeReasons.includes(reason) ? reason : 'requested_by_customer';

    //     if (targetIntent && targetIntent.startsWith('pi_')) {
    //       try {
    //         refund = await stripe.refunds.create({
    //           payment_intent: targetIntent,
    //           reason: stripeReason,
    //           reverse_transfer: true,
    //           refund_application_fee: true
    //         });
    //       } catch (stripeErr) {
    //         if (stripeErr.message.includes('associated transfer') || stripeErr.message.includes('application fee')) {
    //           try {
    //             refund = await stripe.refunds.create({
    //               payment_intent: targetIntent,
    //               reason: stripeReason
    //             });
    //           } catch (fallbackErr) {
    //             console.error('Stripe fallback refund failed:', fallbackErr.message);
    //             return res.status(502).send({ success: false, message: `Stripe rejected refund: ${fallbackErr.message}` });
    //           }
    //         } else {
    //           console.error('Stripe refund failed:', stripeErr.message);
    //           return res.status(502).send({ success: false, message: `Stripe rejected refund: ${stripeErr.message}` });
    //         }
    //       }
    //     }

    //     // 1. Update Payment Status in DB
    //     await paymentCollection.updateOne(
    //       { _id: payment._id },
    //       {
    //         $set: {
    //           status: 'refunded',
    //           refundId: refund ? refund.id : `REF-${Date.now()}`,
    //           refundedAt: new Date().toISOString(),
    //           refundReason: reason || 'Admin initiated refund'
    //         }
    //       }
    //     );

    //     // 2. Revoke Course Access & Adjust Counter
    //     const classIds = Array.isArray(payment.items) && payment.items.length > 0
    //       ? payment.items.map(i => (i.classId || i._id)?.toString()).filter(Boolean)
    //       : (payment.classId ? [payment.classId.toString()] : []);

    //     if (classIds.length > 0) {
    //       await enrollmentCollection.deleteMany({
    //         userEmail: payment.userEmail,
    //         classId: { $in: classIds }
    //       });

    //       for (const cid of classIds) {
    //         if (ObjectId.isValid(cid)) {
    //           await classCollection.updateOne(
    //             { _id: new ObjectId(cid), totalEnrollment: { $gt: 0 } },
    //             { $inc: { totalEnrollment: -1 } }
    //           );
    //         }
    //       }
    //     }

    //     res.send({
    //       success: true,
    //       message: 'Refund issued and enrollments revoked successfully.',
    //       refundId: refund ? refund.id : null
    //     });
    //   } catch (error) {
    //     console.error('Stripe Refund error:', error);
    //     res.status(500).send({ success: false, message: error.message });
    //   }
    // });

    app.post('/admin/payments/refund', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { paymentIntentId, transactionId, reason } = req.body;

        if (!paymentIntentId && !transactionId) {
          return res.status(400).send({ success: false, message: 'Missing transaction/payment identifiers.' });
        }

        const queryConditions = [];
        if (paymentIntentId) queryConditions.push({ transactionId: paymentIntentId });
        if (transactionId) {
          queryConditions.push({ transactionId });
          if (ObjectId.isValid(transactionId)) {
            queryConditions.push({ _id: new ObjectId(transactionId) });
          }
        }

        const payment = await paymentCollection.findOne({ $or: queryConditions });
        if (!payment) {
          return res.status(404).send({ success: false, message: 'Payment record not found.' });
        }

        if (payment.status === 'refunded') {
          return res.status(400).send({ success: false, message: 'Payment is already refunded.' });
        }

        const generatedRefundId = `MANUAL-REF-${Date.now()}`;

        // 1. Update Payment Status in DB
        await paymentCollection.updateOne(
          { _id: payment._id },
          {
            $set: {
              status: 'refunded',
              refundId: generatedRefundId,
              refundedAt: new Date().toISOString(),
              refundReason: reason || 'Admin initiated refund'
            }
          }
        );

        // 2. Revoke Course Access & Adjust Counter
        const classIds = Array.isArray(payment.items) && payment.items.length > 0
          ? payment.items.map(i => (i.classId || i._id)?.toString()).filter(Boolean)
          : (payment.classId ? [payment.classId.toString()] : []);

        if (classIds.length > 0) {
          await enrollmentCollection.deleteMany({
            userEmail: payment.userEmail,
            classId: { $in: classIds }
          });

          for (const cid of classIds) {
            if (ObjectId.isValid(cid)) {
              await classCollection.updateOne(
                { _id: new ObjectId(cid), totalEnrollment: { $gt: 0 } },
                { $inc: { totalEnrollment: -1 } }
              );
            }
          }
        }

        res.send({
          success: true,
          message: 'Refund issued and enrollments revoked successfully.',
          refundId: generatedRefundId
        });
      } catch (error) {
        // console.error('Admin Refund error:', error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // GET /classes/stats/:id (Protected Admin Route)
    // ==========================================
    // ==========================================
    // GET /classes/stats/:id (Class Analytics)
    // ==========================================
    app.get('/classes/stats/:id', verifyToken, async (req, res) => {
      try {
        const classId = req.params.id;

        if (!classId) {
          return res.status(400).send({ message: 'Class ID is required' });
        }

        // Safely parse ObjectId
        const isObjectId = ObjectId.isValid(classId) && (String(new ObjectId(classId)) === classId);
        const objectIdVal = isObjectId ? new ObjectId(classId) : null;

        // 1. Fetch Class Details safely
        const queryConditions = [{ _id: classId }];
        if (objectIdVal) {
          queryConditions.push({ _id: objectIdVal });
        }

        const classData = await classCollection.findOne({ $or: queryConditions });

        if (!classData) {
          return res.status(404).send({ message: 'Class not found' });
        }

        // 2. Build Base Match Query for Payments matching this class
        const matchConditions = [
          { classId: classId },
          { class_Id: classId },
          { "items.classId": classId }
        ];

        if (objectIdVal) {
          matchConditions.push(
            { classId: objectIdVal },
            { class_Id: objectIdVal },
            { "items.classId": objectIdVal }
          );
        }

        const baseMatchQuery = { $or: matchConditions };

        // 3. Aggregate Revenue for ACTIVE/COMPLETED payments only (excludes refunded)
        const revenueStats = await paymentCollection.aggregate([
          {
            $match: {
              $and: [
                baseMatchQuery,
                { status: { $ne: 'refunded' } } // EXCLUDE REFUNDED PAYMENTS FROM REVENUE
              ]
            }
          },
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: { $ifNull: ['$price', { $ifNull: ['$amount', 0] }] } }
            }
          }
        ]).toArray();

        // 4. Fetch Recent Transactions (Includes both completed and refunded for visibility)
        const recentEnrollments = await paymentCollection
          .find(baseMatchQuery)
          .sort({ _id: -1 })
          .limit(10)
          .toArray();

        const revenue = revenueStats[0]?.totalRevenue || 0;

        // 5. Send Response
        res.send({
          classDetails: classData,
          totalRevenue: Number(revenue.toFixed(2)),
          // Prioritize live classData.totalEnrollment counter, default to 0
          totalEnrollments: typeof classData.totalEnrollment === 'number' ? classData.totalEnrollment : 0,
          recentEnrollments,
        });

      } catch (error) {
        // console.error('Error fetching class stats:', error);
        res.status(500).send({ message: 'Internal Server Error', error: error.message });
      }
    });

    // refund

    // GET: Fetch all refund requests (Admin only)
    app.get('/refund-requests', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await refundRequestsCollection.find().sort({ requestedAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // PATCH: Process refund request status (Approve or Reject)
    // POST: Student submits a refund request

    app.post('/refund-requests', verifyToken, async (req, res) => {
      try {
        const { paymentId, reason, explanation, userName } = req.body;

        if (!paymentId) {
          return res.status(400).send({ success: false, message: 'Missing paymentId' });
        }
        if (!explanation || !explanation.trim()) {
          return res.status(400).send({ success: false, message: 'Explanation is required' });
        }

        const paymentQuery = [];
        if (ObjectId.isValid(paymentId)) paymentQuery.push({ _id: new ObjectId(paymentId) });
        paymentQuery.push({ transactionId: paymentId });

        const payment = await paymentCollection.findOne({ $or: paymentQuery });
        if (!payment) {
          return res.status(404).send({ success: false, message: 'Payment not found' });
        }

        // Ownership check
        if (payment.userEmail !== req.decoded.email) {
          return res.status(403).send({ success: false, message: 'Forbidden' });
        }

        if (payment.status === 'refunded') {
          return res.status(400).send({ success: false, message: 'This payment was already refunded' });
        }
        if (payment.status === 'refund_pending') {
          return res.status(400).send({ success: false, message: 'A refund request is already pending for this payment' });
        }

        // --- Refund window, enforced server-side ---
        const REFUND_WINDOW_MINUTES = 5; // TEMP: testing value — change back to days for production

        const paidAt = new Date(payment.paidAt || payment.createdAt);
        const minutesSincePurchase = (Date.now() - paidAt.getTime()) / (1000 * 60);

        if (isNaN(paidAt.getTime())) {
          return res.status(500).send({ success: false, message: 'Payment date could not be determined' });
        }
        if (minutesSincePurchase > REFUND_WINDOW_MINUTES) {
          return res.status(400).send({
            success: false,
            message: `Refund window has expired. Requests must be submitted within ${REFUND_WINDOW_MINUTES} minute(s) of purchase.`
          });
        }

        // --- 7-day window, enforced server-side now, not just in the UI ---
        // const REFUND_WINDOW_DAYS = 7;
        // const paidAt = new Date(payment.paidAt || payment.createdAt);
        // const daysSincePurchase = (Date.now() - paidAt.getTime()) / (1000 * 60 * 60 * 24);

        // if (isNaN(paidAt.getTime())) {
        //   return res.status(500).send({ success: false, message: 'Payment date could not be determined' });
        // }
        // if (daysSincePurchase > REFUND_WINDOW_DAYS) {
        //   return res.status(400).send({
        //     success: false,
        //     message: `Refund window has expired. Requests must be submitted within ${REFUND_WINDOW_DAYS} days of purchase.`
        //   });
        // }

        // --- NEW: Content-consumption gate — max 25% of any purchased course's lessons viewed ---
        const MAX_PROGRESS_PERCENT_FOR_REFUND = 25;

        const classIds = Array.isArray(payment.items) && payment.items.length > 0
          ? payment.items.map(i => (i.classId || i._id)?.toString()).filter(Boolean)
          : (payment.classId ? [payment.classId.toString()] : []);

        if (classIds.length > 0) {
          const progressRecords = await progressCollection.find({
            userEmail: req.decoded.email,
            classId: { $in: classIds }
          }).toArray();

          const progressMap = {};
          progressRecords.forEach(rec => {
            progressMap[rec.classId] = rec.completedLessons || [];
          });

          const validObjectIds = classIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
          const classDocs = await classCollection.find({
            $or: [
              { _id: { $in: validObjectIds } },
              { _id: { $in: classIds } }
            ]
          }).toArray();

          const classDocMap = {};
          classDocs.forEach(c => { classDocMap[c._id.toString()] = c; });

          for (const cId of classIds) {
            const classDoc = classDocMap[cId];

            let totalLessonsCount = 0;
            if (classDoc && Array.isArray(classDoc.modules)) {
              classDoc.modules.forEach(mod => {
                if (Array.isArray(mod.lessons)) totalLessonsCount += mod.lessons.length;
              });
            }
            if (totalLessonsCount === 0) totalLessonsCount = classDoc?.totalLessons || 1;

            const completedCount = (progressMap[cId] || []).length;
            const progressPercent = Math.min(100, Math.round((completedCount / totalLessonsCount) * 100));

            if (progressPercent > MAX_PROGRESS_PERCENT_FOR_REFUND) {
              return res.status(400).send({
                success: false,
                message: `Refund not allowed: you've already viewed ${progressPercent}% of "${classDoc?.title || 'this course'}". Refunds are only available if less than ${MAX_PROGRESS_PERCENT_FOR_REFUND}% of the content has been viewed.`
              });
            }
          }
        }

        const courseTitle = Array.isArray(payment.items) && payment.items.length
          ? payment.items.map(i => i.title).filter(Boolean).join(', ')
          : 'Course Enrollment';

        const result = await refundRequestsCollection.insertOne({
          paymentId: payment._id.toString(),
          userEmail: req.decoded.email,
          userName: userName || '',
          courseTitle,
          amount: payment.price,
          reason: reason || 'Not specified',
          explanation: explanation.trim(),
          status: 'pending',
          requestedAt: new Date()
        });

        await paymentCollection.updateOne(
          { _id: payment._id },
          { $set: { refundRequested: true, status: 'refund_pending' } }
        );

        res.send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        // console.error('Error creating refund request:', error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // app.post('/refund-requests', verifyToken, async (req, res) => {
    //   try {
    //     const { paymentId, reason, explanation, userName } = req.body;

    //     if (!paymentId) {
    //       return res.status(400).send({ success: false, message: 'Missing paymentId' });
    //     }
    //     if (!explanation || !explanation.trim()) {
    //       return res.status(400).send({ success: false, message: 'Explanation is required' });
    //     }

    //     const paymentQuery = [];
    //     if (ObjectId.isValid(paymentId)) paymentQuery.push({ _id: new ObjectId(paymentId) });
    //     paymentQuery.push({ transactionId: paymentId });

    //     const payment = await paymentCollection.findOne({ $or: paymentQuery });
    //     if (!payment) {
    //       return res.status(404).send({ success: false, message: 'Payment not found' });
    //     }

    //     // Ownership check
    //     if (payment.userEmail !== req.decoded.email) {
    //       return res.status(403).send({ success: false, message: 'Forbidden' });
    //     }

    //     if (payment.status === 'refunded') {
    //       return res.status(400).send({ success: false, message: 'This payment was already refunded' });
    //     }
    //     if (payment.status === 'refund_pending') {
    //       return res.status(400).send({ success: false, message: 'A refund request is already pending for this payment' });
    //     }

    //     // --- 7-day window, enforced server-side now, not just in the UI ---
    //     // const REFUND_WINDOW_DAYS = 7;
    //     // const paidAt = new Date(payment.paidAt || payment.createdAt);
    //     // const daysSincePurchase = (Date.now() - paidAt.getTime()) / (1000 * 60 * 60 * 24);

    //     // if (isNaN(paidAt.getTime())) {
    //     //   return res.status(500).send({ success: false, message: 'Payment date could not be determined' });
    //     // }
    //     // if (daysSincePurchase > REFUND_WINDOW_DAYS) {
    //     //   return res.status(400).send({
    //     //     success: false,
    //     //     message: `Refund window has expired. Requests must be submitted within ${REFUND_WINDOW_DAYS} days of purchase.`
    //     //   });
    //     // }

    //     // --- Refund window, enforced server-side ---
    //     const REFUND_WINDOW_MINUTES = 1; // TEMP: testing value — change back to days for production

    //     const paidAt = new Date(payment.paidAt || payment.createdAt);
    //     const minutesSincePurchase = (Date.now() - paidAt.getTime()) / (1000 * 60);

    //     if (isNaN(paidAt.getTime())) {
    //       return res.status(500).send({ success: false, message: 'Payment date could not be determined' });
    //     }
    //     if (minutesSincePurchase > REFUND_WINDOW_MINUTES) {
    //       return res.status(400).send({
    //         success: false,
    //         message: `Refund window has expired. Requests must be submitted within ${REFUND_WINDOW_MINUTES} minute(s) of purchase.`
    //       });
    //     }

    //     const courseTitle = Array.isArray(payment.items) && payment.items.length
    //       ? payment.items.map(i => i.title).filter(Boolean).join(', ')
    //       : 'Course Enrollment';

    //     const result = await refundRequestsCollection.insertOne({
    //       paymentId: payment._id.toString(),
    //       userEmail: req.decoded.email,
    //       userName: userName || '',
    //       courseTitle,
    //       amount: payment.price,
    //       reason: reason || 'Not specified',
    //       explanation: explanation.trim(),
    //       status: 'pending',
    //       requestedAt: new Date()
    //     });

    //     await paymentCollection.updateOne(
    //       { _id: payment._id },
    //       { $set: { refundRequested: true, status: 'refund_pending' } }
    //     );

    //     res.send({ success: true, insertedId: result.insertedId });
    //   } catch (error) {
    //     console.error('Error creating refund request:', error);
    //     res.status(500).send({ success: false, message: error.message });
    //   }
    // });

    // PATCH: Admin approves or rejects — approval now actually calls Stripe
    // =========================================================================
    // 2. PATCH /refund-requests/:id (Approve/Reject Student Request)
    // =========================================================================
    // app.patch('/refund-requests/:id', verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const { id } = req.params;
    //     const { status } = req.body;

    //     if (!ObjectId.isValid(id)) {
    //       return res.status(400).send({ success: false, message: 'Invalid Refund Request ID' });
    //     }

    //     const refundRequest = await refundRequestsCollection.findOne({ _id: new ObjectId(id) });
    //     if (!refundRequest || refundRequest.status !== 'pending') {
    //       return res.status(400).send({ success: false, message: 'Invalid or already processed request' });
    //     }

    //     const payment = await paymentCollection.findOne({
    //       $or: [
    //         { _id: ObjectId.isValid(refundRequest.paymentId) ? new ObjectId(refundRequest.paymentId) : null },
    //         { transactionId: refundRequest.paymentId }
    //       ]
    //     });

    //     if (!payment) {
    //       return res.status(404).send({ success: false, message: 'Associated payment record not found' });
    //     }

    //     // --- REJECT PATH ---
    //     if (status === 'rejected') {
    //       await refundRequestsCollection.updateOne(
    //         { _id: new ObjectId(id) },
    //         { $set: { status: 'rejected', updatedAt: new Date() } }
    //       );
    //       await paymentCollection.updateOne(
    //         { _id: payment._id },
    //         { $set: { status: 'completed', refundRequested: false } }
    //       );
    //       return res.send({ success: true, message: 'Refund request rejected.' });
    //     }

    //     // --- APPROVE PATH ---
    //     let stripeRefund = null;
    //     const paymentIntentId = payment.stripePaymentIntentId || payment.transactionId;

    //     if (paymentIntentId && paymentIntentId.startsWith('pi_')) {
    //       try {
    //         stripeRefund = await stripe.refunds.create({
    //           payment_intent: paymentIntentId,
    //           reason: 'requested_by_customer',
    //           reverse_transfer: true,
    //           refund_application_fee: true
    //         });
    //       } catch (stripeErr) {
    //         // Fallback: Handle charges that do not have associated Stripe Connect transfers
    //         if (stripeErr.message.includes('associated transfer') || stripeErr.message.includes('application fee')) {
    //           try {
    //             stripeRefund = await stripe.refunds.create({
    //               payment_intent: paymentIntentId,
    //               reason: 'requested_by_customer'
    //             });
    //           } catch (fallbackErr) {
    //             console.error('Stripe processing failure during fallback:', fallbackErr.message);
    //             return res.status(502).send({
    //               success: false,
    //               message: `Stripe rejected the refund: ${fallbackErr.message}`
    //             });
    //           }
    //         } else {
    //           console.error('Stripe processing failure:', stripeErr.message);
    //           return res.status(502).send({
    //             success: false,
    //             message: `Stripe rejected the refund: ${stripeErr.message}`
    //           });
    //         }
    //       }
    //     }

    //     // Database Updates
    //     await paymentCollection.updateOne(
    //       { _id: payment._id },
    //       {
    //         $set: {
    //           status: 'refunded',
    //           refundId: stripeRefund ? stripeRefund.id : `MANUAL-REF-${Date.now()}`,
    //           refundedAt: new Date()
    //         }
    //       }
    //     );

    //     await refundRequestsCollection.updateOne(
    //       { _id: new ObjectId(id) },
    //       { $set: { status: 'approved', updatedAt: new Date() } }
    //     );

    //     // Access Revocation
    //     const classIds = Array.isArray(payment.items) && payment.items.length > 0
    //       ? payment.items.map(i => (i.classId || i._id)?.toString()).filter(Boolean)
    //       : (payment.classId ? [payment.classId.toString()] : []);

    //     if (classIds.length > 0) {
    //       await enrollmentCollection.deleteMany({
    //         userEmail: payment.userEmail,
    //         classId: { $in: classIds }
    //       });

    //       for (const cid of classIds) {
    //         if (ObjectId.isValid(cid)) {
    //           await classCollection.updateOne(
    //             { _id: new ObjectId(cid), totalEnrollment: { $gt: 0 } },
    //             { $inc: { totalEnrollment: -1 } }
    //           );
    //         }
    //       }
    //     }

    //     res.send({
    //       success: true,
    //       message: 'Refund approved. Funds returned and enrollment revoked.',
    //       refundId: stripeRefund ? stripeRefund.id : null
    //     });
    //   } catch (error) {
    //     console.error('Refund system error:', error);
    //     res.status(500).send({ success: false, message: error.message });
    //   }
    // });

    // 1. Process Student Refund Request (Approve / Reject)
    app.patch('/refund-requests/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ success: false, message: 'Invalid Refund Request ID' });
        }

        const refundRequest = await refundRequestsCollection.findOne({ _id: new ObjectId(id) });
        if (!refundRequest || refundRequest.status !== 'pending') {
          return res.status(400).send({ success: false, message: 'Invalid or already processed request' });
        }

        const payment = await paymentCollection.findOne({
          $or: [
            { _id: ObjectId.isValid(refundRequest.paymentId) ? new ObjectId(refundRequest.paymentId) : null },
            { transactionId: refundRequest.paymentId }
          ]
        });

        if (!payment) {
          return res.status(404).send({ success: false, message: 'Associated payment record not found' });
        }

        // --- REJECT PATH ---
        if (status === 'rejected') {
          await refundRequestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: 'rejected', updatedAt: new Date() } }
          );
          await paymentCollection.updateOne(
            { _id: payment._id },
            { $set: { status: 'completed', refundRequested: false } }
          );
          return res.send({ success: true, message: 'Refund request rejected.' });
        }

        // --- APPROVE PATH ---
        const generatedRefundId = `MANUAL-REF-${Date.now()}`;

        // Database Updates
        await paymentCollection.updateOne(
          { _id: payment._id },
          {
            $set: {
              status: 'refunded',
              refundId: generatedRefundId,
              refundedAt: new Date()
            }
          }
        );

        await refundRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: 'approved', updatedAt: new Date() } }
        );

        // Access Revocation & Student Counter Decrement
        const classIds = Array.isArray(payment.items) && payment.items.length > 0
          ? payment.items.map(i => (i.classId || i._id)?.toString()).filter(Boolean)
          : (payment.classId ? [payment.classId.toString()] : []);

        if (classIds.length > 0) {
          await enrollmentCollection.deleteMany({
            userEmail: payment.userEmail,
            classId: { $in: classIds }
          });

          for (const cid of classIds) {
            if (ObjectId.isValid(cid)) {
              await classCollection.updateOne(
                { _id: new ObjectId(cid), totalEnrollment: { $gt: 0 } },
                { $inc: { totalEnrollment: -1 } }
              );
            }
          }
        }

        res.send({
          success: true,
          message: 'Refund approved. Enrollment revoked and recorded.',
          refundId: generatedRefundId
        });
      } catch (error) {
        // console.error('Refund system error:', error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // etao change krsi last time
    // app.get('/enrolled-classes', verifyToken, async (req, res) => {
    //   try {
    //     const userEmail = req.decoded?.email || req.user?.email;
    //     if (!userEmail) {
    //       return res.status(401).send({ message: 'Unauthorized access' });
    //     }

    //     // 1. Fetch payments for this user
    //     const payments = await paymentCollection
    //       .find({
    //         $or: [
    //           { userEmail: userEmail },
    //           { email: userEmail },
    //           { studentEmail: userEmail }
    //         ]
    //       })
    //       .sort({ paidAt: -1, _id: -1 })
    //       .toArray();

    //     if (!payments || payments.length === 0) {
    //       return res.send([]);
    //     }

    //     // 2. Extract class IDs from payment items
    //     const classIds = [];
    //     payments.forEach(payment => {
    //       if (Array.isArray(payment.items) && payment.items.length > 0) {
    //         payment.items.forEach(item => {
    //           const targetId = item.classId || item._id || item.id || item.courseId || payment.classId;
    //           if (targetId) classIds.push(targetId.toString());
    //         });
    //       } else if (payment.classId) {
    //         classIds.push(payment.classId.toString());
    //       }
    //     });

    //     const uniqueClassIds = [...new Set(classIds)];
    //     const validObjectIds = uniqueClassIds
    //       .filter(id => id && ObjectId.isValid(id))
    //       .map(id => new ObjectId(id));

    //     // 3. Fetch matching classes
    //     let classes = [];
    //     if (validObjectIds.length > 0 || uniqueClassIds.length > 0) {
    //       classes = await classCollection
    //         .find({
    //           $or: [
    //             { _id: { $in: validObjectIds } },
    //             { _id: { $in: uniqueClassIds } }
    //           ]
    //         })
    //         .toArray();
    //     }

    //     const classMap = {};
    //     classes.forEach(cls => {
    //       if (cls && cls._id) {
    //         classMap[cls._id.toString()] = cls;
    //       }
    //     });

    //     // 4. Fetch refund requests safely
    //     let refundRequests = [];
    //     try {
    //       refundRequests = await refundCollection
    //         .find({
    //           $or: [
    //             { userEmail: userEmail },
    //             { email: userEmail },
    //             { studentEmail: userEmail }
    //           ]
    //         })
    //         .toArray();
    //     } catch (e) {
    //       refundRequests = [];
    //     }

    //     const refundMap = {};
    //     refundRequests.forEach(ref => {
    //       if (ref && ref.classId) {
    //         refundMap[ref.classId.toString()] = ref.status;
    //       }
    //     });

    //     // 5. Fetch lesson progress records for this user (from progressCollection)
    //     let userProgressRecords = [];
    //     try {
    //       userProgressRecords = await progressCollection
    //         .find({ userEmail })
    //         .toArray();
    //     } catch (e) {
    //       userProgressRecords = [];
    //     }

    //     const progressMap = {};
    //     userProgressRecords.forEach(rec => {
    //       if (rec && rec.classId) {
    //         progressMap[rec.classId.toString()] = rec.completedLessons || [];
    //       }
    //     });

    //     // 6. Build enrollment list with real dynamic lesson progress calculation
    //     const enrolledCourses = payments.flatMap(payment => {
    //       const items = Array.isArray(payment.items) && payment.items.length > 0
    //         ? payment.items
    //         : [payment];

    //       return items.map(item => {
    //         const cId = (item.classId || item._id || item.id || item.courseId || payment.classId)?.toString();
    //         const courseData = (cId ? classMap[cId] : null) || {};

    //         // Calculate total lessons from nested modules structure
    //         let totalLessonsCount = 0;
    //         if (Array.isArray(courseData.modules)) {
    //           courseData.modules.forEach(mod => {
    //             if (Array.isArray(mod.lessons)) {
    //               totalLessonsCount += mod.lessons.length;
    //             }
    //           });
    //         }
    //         if (totalLessonsCount === 0) {
    //           totalLessonsCount = courseData.totalLessons || 1;
    //         }

    //         const completedLessons = (cId && progressMap[cId]) ? progressMap[cId] : [];
    //         const completedCount = completedLessons.length;
    //         const progressPercent = Math.min(100, Math.round((completedCount / totalLessonsCount) * 100));

    //         return {
    //           enrollmentId: payment._id,
    //           transactionId: payment.transactionId || 'N/A',
    //           classId: cId || payment._id.toString(),
    //           title: courseData.title || courseData.className || item.title || item.name || 'Enrolled Course',
    //           image: courseData.image || courseData.bannerImage || courseData.coverImage || item.image || '',
    //           category: courseData.category || item.category || 'General',
    //           instructorName: courseData.instructorName || courseData.teacherName || courseData.name || item.instructorName || 'Instructor',
    //           instructorEmail: courseData.instructorEmail || courseData.teacherEmail || courseData.email || item.instructorEmail || '',
    //           pricePaid: item.price || payment.price || 0,
    //           paymentStatus: payment.status || 'completed',
    //           refundStatus: (cId && refundMap[cId]) || (payment.status === 'refunded' ? 'approved' : null),
    //           enrolledAt: payment.paidAt || payment.createdAt || new Date(),
    //           totalLessons: totalLessonsCount,
    //           completedLessons: completedLessons,
    //           completedCount: completedCount,
    //           progressPercent: progressPercent,
    //         };
    //       });
    //     });

    //     res.send(enrolledCourses);
    //   } catch (error) {
    //     console.error('Error fetching enrolled classes:', error);
    //     res.status(500).send({ message: 'Failed to retrieve enrolled classes', error: error.message });
    //   }
    // });

    app.get('/enrolled-classes', verifyToken, async (req, res) => {
      try {
        const userEmail = req.decoded?.email || req.user?.email;
        if (!userEmail) {
          return res.status(401).send({ message: 'Unauthorized access' });
        }

        // 1. Fetch payments for this user
        const payments = await paymentCollection
          .find({
            $or: [
              { userEmail: userEmail },
              { email: userEmail },
              { studentEmail: userEmail }
            ]
          })
          .sort({ paidAt: -1, _id: -1 })
          .toArray();

        if (!payments || payments.length === 0) {
          return res.send([]);
        }

        // 2. Extract class IDs from payment items
        const classIds = [];
        payments.forEach(payment => {
          if (Array.isArray(payment.items) && payment.items.length > 0) {
            payment.items.forEach(item => {
              const targetId = item.classId || item._id || item.id || item.courseId || payment.classId;
              if (targetId) classIds.push(targetId.toString());
            });
          } else if (payment.classId) {
            classIds.push(payment.classId.toString());
          }
        });

        const uniqueClassIds = [...new Set(classIds)];
        const validObjectIds = uniqueClassIds
          .filter(id => id && ObjectId.isValid(id))
          .map(id => new ObjectId(id));

        // 3. Fetch matching classes
        let classes = [];
        if (validObjectIds.length > 0 || uniqueClassIds.length > 0) {
          classes = await classCollection
            .find({
              $or: [
                { _id: { $in: validObjectIds } },
                { _id: { $in: uniqueClassIds } }
              ]
            })
            .toArray();
        }

        const classMap = {};
        classes.forEach(cls => {
          if (cls && cls._id) {
            classMap[cls._id.toString()] = cls;
          }
        });

        // 4. Fetch lesson progress records for this user (from progressCollection)
        let userProgressRecords = [];
        try {
          userProgressRecords = await progressCollection
            .find({ userEmail })
            .toArray();
        } catch (e) {
          userProgressRecords = [];
        }

        const progressMap = {};
        userProgressRecords.forEach(rec => {
          if (rec && rec.classId) {
            progressMap[rec.classId.toString()] = rec.completedLessons || [];
          }
        });

        // 5. Build enrollment list with real dynamic lesson progress calculation
        const enrolledCourses = payments.flatMap(payment => {
          const items = Array.isArray(payment.items) && payment.items.length > 0
            ? payment.items
            : [payment];

          return items.map(item => {
            const cId = (item.classId || item._id || item.id || item.courseId || payment.classId)?.toString();
            const courseData = (cId ? classMap[cId] : null) || {};

            // Calculate total lessons from nested modules structure
            let totalLessonsCount = 0;
            if (Array.isArray(courseData.modules)) {
              courseData.modules.forEach(mod => {
                if (Array.isArray(mod.lessons)) {
                  totalLessonsCount += mod.lessons.length;
                }
              });
            }
            if (totalLessonsCount === 0) {
              totalLessonsCount = courseData.totalLessons || 1;
            }

            const completedLessons = (cId && progressMap[cId]) ? progressMap[cId] : [];
            const completedCount = completedLessons.length;
            const progressPercent = Math.min(100, Math.round((completedCount / totalLessonsCount) * 100));

            return {
              enrollmentId: payment._id,
              transactionId: payment.transactionId || 'N/A',
              classId: cId || payment._id.toString(),
              title: courseData.title || courseData.className || item.title || item.name || 'Enrolled Course',
              image: courseData.image || courseData.bannerImage || courseData.coverImage || item.image || '',
              category: courseData.category || item.category || 'General',
              instructorName: courseData.instructorName || courseData.teacherName || courseData.name || item.instructorName || 'Instructor',
              instructorEmail: courseData.instructorEmail || courseData.teacherEmail || courseData.email || item.instructorEmail || '',
              pricePaid: item.price || payment.price || 0,
              paymentStatus: payment.status || 'completed',
              refundStatus: payment.status === 'refunded' ? 'approved'
                : payment.status === 'refund_pending' ? 'pending'
                  : null,
              enrolledAt: payment.paidAt || payment.createdAt || new Date(),
              totalLessons: totalLessonsCount,
              completedLessons: completedLessons,
              completedCount: completedCount,
              progressPercent: progressPercent,
            };
          });
        });

        res.send(enrolledCourses);
      } catch (error) {
        // console.error('Error fetching enrolled classes:', error);
        res.status(500).send({ message: 'Failed to retrieve enrolled classes', error: error.message });
      }
    });

    app.patch('/enrolled-classes/complete-lesson', verifyToken, async (req, res) => {
      try {
        const userEmail = req.decoded?.email || req.user?.email;
        const { classId, lessonId } = req.body;

        if (!userEmail || !classId || !lessonId) {
          return res.status(400).send({ message: 'Missing required parameters (classId, lessonId)' });
        }

        // Add lessonId to completedLessons array uniquely using Native MongoDB Driver
        const result = await progressCollection.updateOne(
          { userEmail: userEmail, classId: classId.toString() },
          {
            $addToSet: { completedLessons: lessonId },
            $setOnInsert: { createdAt: new Date() },
            $set: { updatedAt: new Date() }
          },
          { upsert: true }
        );

        res.send({ success: true, result });
      } catch (error) {
        // console.error('Error updating lesson progress:', error);
        res.status(500).send({ message: 'Failed to update lesson progress', error: error.message });
      }
    });

    // GET: Single enrolled class with lessons, for the course player page
    app.get('/enrolled-classes/:id', verifyToken, async (req, res) => {
      try {
        const userEmail = req.decoded?.email;
        const classId = req.params.id;

        const payment = await paymentCollection.findOne({
          userEmail,
          status: { $ne: 'refunded' },
          $or: [
            { 'items.classId': classId },
            { 'items._id': classId },
            { classId: classId }
          ]
        });

        if (!payment) {
          return res.status(403).send({ message: 'You are not enrolled in this class' });
        }

        const idConditions = [{ _id: classId }];
        if (ObjectId.isValid(classId)) {
          idConditions.push({ _id: new ObjectId(classId) });
        }

        const classData = await classCollection.findOne({ $or: idConditions });
        if (!classData) {
          return res.status(404).send({ message: 'Class not found' });
        }

        const lessons = [];
        if (Array.isArray(classData.modules)) {
          classData.modules.forEach((mod) => {
            if (Array.isArray(mod.lessons)) {
              mod.lessons.forEach((lesson) => {
                lessons.push({
                  id: lesson._id || lesson.id || `${lessons.length}`,
                  title: lesson.title || `Lesson ${lessons.length + 1}`,
                  duration: lesson.duration || null,
                  videoUrl: lesson.videoUrl || lesson.url || '',
                  moduleTitle: mod.title || ''
                });
              });
            }
          });
        }

        const progressRecord = await progressCollection.findOne({
          userEmail,
          classId: classId.toString()
        });
        const completedLessons = progressRecord?.completedLessons || [];

        // NEW: assignments for this class
        const assignments = await assignmentsCollection.find({ classId: classId.toString() }).toArray();

        // NEW: this student's own submissions for those assignments
        const mySubmissions = await submissionsCollection
          .find({ classId: classId.toString(), userEmail })
          .toArray();

        const submissionByAssignment = {};
        mySubmissions.forEach((s) => { submissionByAssignment[s.assignmentId] = s; });

        const assignmentsWithStatus = assignments.map((a) => {
          const sub = submissionByAssignment[a._id.toString()];
          return {
            _id: a._id,
            title: a.title,
            description: a.description,
            submission: sub
              ? {
                githubLink: sub.githubLink,
                status: sub.status,
                grade: sub.grade,
                feedback: sub.feedback,
                submittedAt: sub.submittedAt
              }
              : null
          };
        });

        res.send({
          title: classData.title,
          lessons,
          classId: classData._id,
          completedLessons,
          assignments: assignmentsWithStatus
        });
      } catch (error) {
        // console.error('Error fetching class detail:', error);
        res.status(500).send({ message: 'Failed to fetch class details', error: error.message });
      }
    });

    // POST: etao last a cmnt krslm
    // app.post('/request-refund', verifyToken, async (req, res) => {
    //   try {
    //     const { classId, transactionId, reason, detail, amount } = req.body;
    //     const userEmail = req.user?.email;
    //     const userName = req.user?.displayName || 'Student';

    //     if (!classId || !reason) {
    //       return res.status(400).send({ message: 'Class ID and reason are required' });
    //     }

    //     // Prevent duplicate active requests
    //     const existing = await refundCollection.findOne({ classId, userEmail, status: 'pending' });
    //     if (existing) {
    //       return res.status(400).send({ message: 'A refund request for this course is already pending.' });
    //     }

    //     const refundDoc = {
    //       classId,
    //       transactionId,
    //       userEmail,
    //       userName,
    //       reason,
    //       detail: detail || '',
    //       amount: Number(amount || 0),
    //       status: 'pending',
    //       requestedAt: new Date()
    //     };

    //     const result = await refundCollection.insertOne(refundDoc);
    //     res.send({ success: true, insertedId: result.insertedId, message: 'Refund request submitted successfully' });
    //   } catch (error) {
    //     console.error('Error requesting refund:', error);
    //     res.status(500).send({ message: 'Failed to submit refund request' });
    //   }
    // });

    app.post('/newsletter/subscribe', async (req, res) => {
      try {
        const { email } = req.body;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!email || !emailRegex.test(email)) {
          return res.status(400).send({ success: false, message: 'Please enter a valid email address.' });
        }

        const existing = await newsletterCollection.findOne({ email });
        if (existing) {
          return res.status(400).send({ success: false, message: 'This email is already subscribed.' });
        }

        await newsletterCollection.insertOne({
          email,
          subscribedAt: new Date()
        });

        res.send({ success: true, message: 'Thank you for subscribing!' });
      } catch (error) {
        // console.error('Newsletter subscribe error:', error);
        res.status(500).send({ success: false, message: 'Failed to subscribe. Please try again.' });
      }
    });

    // GET: Fetch all newsletter subscribers (Admin only)
    app.get('/newsletter/subscribers', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await newsletterCollection
          .find()
          .sort({ subscribedAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        // console.error('Error fetching newsletter subscribers:', error);
        res.status(500).send({ message: 'Failed to fetch subscribers', error: error.message });
      }
    });

    // GET: List students enrolled in a specific classes
    app.get('/classes/:id/students', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const classId = req.params.id;
        const requesterEmail = req.decoded.email;

        if (!ObjectId.isValid(classId)) {
          return res.status(400).send({ message: 'Invalid Class ID' });
        }

        const targetClass = await classCollection.findOne({ _id: new ObjectId(classId) });
        if (!targetClass) {
          return res.status(404).send({ message: 'Class not found' });
        }

        const requester = await usersCollection.findOne({ email: requesterEmail });
        const isOwner = targetClass.teacherEmail === requesterEmail || targetClass.email === requesterEmail;
        if (requester?.role !== 'admin' && !isOwner) {
          return res.status(403).send({ message: 'Forbidden: You can only view students in your own classes' });
        }

        const enrollments = await enrollmentCollection
          .find({ classId: { $in: [classId, classId.toString()] } })
          .sort({ enrolledAt: -1 })
          .toArray();

        const seen = new Set();
        const students = [];
        for (const enr of enrollments) {
          if (seen.has(enr.userEmail)) continue;
          seen.add(enr.userEmail);

          const userDoc = await usersCollection.findOne({ email: enr.userEmail });

          students.push({
            userEmail: enr.userEmail,
            userName: enr.userName || userDoc?.name || 'Student',
            userImage: userDoc?.photoURL || userDoc?.image || '',
            enrolledAt: enr.enrolledAt,
            transactionId: enr.transactionId || 'N/A'
          });
        }

        res.send({
          classTitle: targetClass.title,
          totalStudents: students.length,
          students
        });
      } catch (error) {
        // console.error('Error fetching enrolled students:', error);
        res.status(500).send({ message: 'Failed to fetch enrolled students', error: error.message });
      }
    });

    app.post('/submissions', verifyToken, async (req, res) => {
      try {
        const { assignmentId, classId, githubLink } = req.body;
        const userEmail = req.decoded.email;

        if (!assignmentId || !classId) {
          return res.status(400).send({ message: 'assignmentId and classId are required' });
        }
        if (!githubLink || !githubLink.trim()) {
          return res.status(400).send({ message: 'A GitHub repository link is required' });
        }

        const githubUrlRegex = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?$/i;
        if (!githubUrlRegex.test(githubLink.trim())) {
          return res.status(400).send({ message: 'Please provide a valid GitHub repository URL (e.g. https://github.com/username/repo)' });
        }

        const payment = await paymentCollection.findOne({
          userEmail,
          status: { $ne: 'refunded' },
          $or: [
            { 'items.classId': classId },
            { 'items._id': classId },
            { classId: classId }
          ]
        });
        if (!payment) {
          return res.status(403).send({ message: 'You must be enrolled in this class to submit an assignment' });
        }

        const assignment = await assignmentsCollection.findOne(
          ObjectId.isValid(assignmentId) ? { _id: new ObjectId(assignmentId) } : { _id: assignmentId }
        );
        if (!assignment) {
          return res.status(404).send({ message: 'Assignment not found' });
        }

        const existing = await submissionsCollection.findOne({ assignmentId: assignmentId.toString(), userEmail });
        const userDoc = await usersCollection.findOne({ email: userEmail });

        const submissionDoc = {
          assignmentId: assignmentId.toString(),
          classId: classId.toString(),
          userEmail,
          userName: userDoc?.name || 'Student',
          githubLink: githubLink.trim(),
          status: 'submitted',
          grade: null,
          feedback: '',
          submittedAt: new Date(),
          gradedAt: null
        };

        let result;
        if (existing) {
          await submissionsCollection.updateOne(
            { _id: existing._id },
            { $set: { ...submissionDoc, status: 'submitted', grade: null, feedback: '', gradedAt: null } }
          );
          result = { insertedId: existing._id, resubmitted: true };
        } else {
          const inserted = await submissionsCollection.insertOne(submissionDoc);
          result = { insertedId: inserted.insertedId, resubmitted: false };
        }

        res.status(201).send({ success: true, ...result });
      } catch (error) {
        // console.error('Error submitting assignment:', error);
        res.status(500).send({ message: 'Failed to submit assignment', error: error.message });
      }
    });

    app.patch('/submissions/:id/grade', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { grade, feedback } = req.body;
        const requesterEmail = req.decoded.email;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid Submission ID' });
        }
        const numericGrade = Number(grade);
        if (grade === undefined || grade === null || isNaN(numericGrade) || numericGrade < 0 || numericGrade > 100) {
          return res.status(400).send({ message: 'Grade must be a number between 0 and 100' });
        }

        const submission = await submissionsCollection.findOne({ _id: new ObjectId(id) });
        if (!submission) {
          return res.status(404).send({ message: 'Submission not found' });
        }

        if (!ObjectId.isValid(submission.classId)) {
          return res.status(400).send({ message: 'Submission has an invalid class reference' });
        }
        const parentClass = await classCollection.findOne({ _id: new ObjectId(submission.classId) });
        const requester = await usersCollection.findOne({ email: requesterEmail });
        const isOwner = parentClass?.teacherEmail === requesterEmail || parentClass?.email === requesterEmail;

        if (requester?.role !== 'admin' && !isOwner) {
          return res.status(403).send({ message: 'Forbidden: You can only grade submissions for your own classes' });
        }

        const result = await submissionsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: 'graded',
              grade: numericGrade,
              feedback: feedback || '',
              gradedAt: new Date()
            }
          }
        );

        res.send({ success: true, result });
      } catch (error) {
        // console.error('Error grading submission:', error);
        res.status(500).send({ message: 'Failed to grade submission', error: error.message });
      }
    });

    const CERTIFICATE_PASS_THRESHOLD = 80;

    app.get('/certificate/status/:classId', verifyToken, async (req, res) => {
      try {
        const { classId } = req.params;
        const userEmail = req.decoded.email;

        const payment = await paymentCollection.findOne({
          userEmail,
          status: { $ne: 'refunded' },
          $or: [
            { 'items.classId': classId },
            { 'items._id': classId },
            { classId: classId }
          ]
        });
        if (!payment) {
          return res.status(403).send({ message: 'You are not enrolled in this class' });
        }

        // NEW: fetch class + user info so the certificate has real data to render
        const classIdConditions = [{ _id: classId }];
        if (ObjectId.isValid(classId)) classIdConditions.push({ _id: new ObjectId(classId) });
        const classData = await classCollection.findOne({ $or: classIdConditions });
        const userDoc = await usersCollection.findOne({ email: userEmail });

        const allAssignments = await assignmentsCollection.find({ classId }).toArray();

        if (allAssignments.length === 0) {
          return res.send({
            eligible: false,
            reason: 'This course has no assignments configured yet',
            totalAssignments: 0,
            passedAssignments: 0
          });
        }

        const mySubmissions = await submissionsCollection
          .find({ classId, userEmail })
          .toArray();

        const submissionByAssignment = {};
        mySubmissions.forEach((s) => { submissionByAssignment[s.assignmentId] = s; });

        let passedCount = 0;
        let lastGradedAt = null;
        const breakdown = allAssignments.map((a) => {
          const sub = submissionByAssignment[a._id.toString()];
          const passed = sub?.status === 'graded' && sub.grade >= CERTIFICATE_PASS_THRESHOLD;
          if (passed) {
            passedCount++;
            if (sub.gradedAt && (!lastGradedAt || new Date(sub.gradedAt) > new Date(lastGradedAt))) {
              lastGradedAt = sub.gradedAt;
            }
          }
          return {
            assignmentId: a._id,
            title: a.title,
            submitted: Boolean(sub),
            grade: sub?.grade ?? null,
            passed
          };
        });

        const eligible = passedCount === allAssignments.length;

        res.send({
          eligible,
          totalAssignments: allAssignments.length,
          passedAssignments: passedCount,
          threshold: CERTIFICATE_PASS_THRESHOLD,
          breakdown,
          // NEW: fields the certificate template needs
          courseTitle: classData?.title || 'Course',
          studentName: userDoc?.name || 'Student',
          instructorName: classData?.teacherName || classData?.name || 'Instructor',
          completionDate: lastGradedAt || new Date()
        });
      } catch (error) {
        // console.error('Error checking certificate eligibility:', error);
        res.status(500).send({ message: 'Failed to check certificate status', error: error.message });
      }
    });

    // Generate a semantic embedding vector for a course, using its meaningful text content
    async function generateCourseEmbedding(course) {
      try {
        const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });

        const textToEmbed = [
          course.title,
          course.category,
          course.shortDescription,
          course.description,
          Array.isArray(course.objectives) ? course.objectives.join('. ') : ''
        ].filter(Boolean).join('. ');

        if (!textToEmbed.trim()) return null;

        const result = await model.embedContent(textToEmbed);
        return result.embedding.values; // array of ~768 numbers
      } catch (error) {
        // console.error('Embedding generation failed:', error.message);
        return null; // fail gracefully — course still saves, just without recommendations
      }
    }

    // Cosine similarity: measures how close two vectors point in the same direction (1 = identical, 0 = unrelated)
    function cosineSimilarity(vecA, vecB) {
      if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

      let dotProduct = 0, normA = 0, normB = 0;
      for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
      }
      if (normA === 0 || normB === 0) return 0;
      return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }


    // POST: Bulk certificate eligibility check for multiple classes at once
    app.post('/certificate/status/bulk', verifyToken, async (req, res) => {
      try {
        const { classIds } = req.body;
        const userEmail = req.decoded.email;

        if (!Array.isArray(classIds) || classIds.length === 0) {
          return res.send({});
        }

        const uniqueClassIds = [...new Set(classIds.map(String))];

        // 1. Verify enrollment for all requested classes in one query
        const payments = await paymentCollection.find({
          userEmail,
          status: { $ne: 'refunded' },
          $or: [
            { 'items.classId': { $in: uniqueClassIds } },
            { 'items._id': { $in: uniqueClassIds } },
            { classId: { $in: uniqueClassIds } }
          ]
        }).toArray();

        const enrolledClassIds = new Set();
        payments.forEach(p => {
          if (Array.isArray(p.items) && p.items.length > 0) {
            p.items.forEach(item => {
              const cid = (item.classId || item._id)?.toString();
              if (cid) enrolledClassIds.add(cid);
            });
          } else if (p.classId) {
            enrolledClassIds.add(p.classId.toString());
          }
        });

        // 2. Fetch class titles for enrolled classes
        const validObjectIds = uniqueClassIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
        const classDocs = await classCollection.find({
          $or: [
            { _id: { $in: validObjectIds } },
            { _id: { $in: uniqueClassIds } }
          ]
        }).toArray();
        const classDocMap = {};
        classDocs.forEach(c => { classDocMap[c._id.toString()] = c; });

        // 3. Fetch all assignments for these classes in one query
        const allAssignments = await assignmentsCollection.find({
          classId: { $in: uniqueClassIds }
        }).toArray();

        const assignmentsByClass = {};
        allAssignments.forEach(a => {
          if (!assignmentsByClass[a.classId]) assignmentsByClass[a.classId] = [];
          assignmentsByClass[a.classId].push(a);
        });

        // 4. Fetch all of this student's submissions for these classes in one query
        const mySubmissions = await submissionsCollection.find({
          classId: { $in: uniqueClassIds },
          userEmail
        }).toArray();

        const submissionByAssignment = {};
        mySubmissions.forEach(s => { submissionByAssignment[s.assignmentId] = s; });

        // 5. Build per-class result
        const result = {};
        for (const cId of uniqueClassIds) {
          if (!enrolledClassIds.has(cId)) {
            continue; // skip classes the student isn't enrolled in
          }

          const classAssignments = assignmentsByClass[cId] || [];
          const totalAssignments = classAssignments.length;

          if (totalAssignments === 0) {
            result[cId] = {
              eligible: false,
              totalAssignments: 0,
              passedAssignments: 0,
              courseTitle: classDocMap[cId]?.title || 'Course'
            };
            continue;
          }

          let passedCount = 0;
          classAssignments.forEach(a => {
            const sub = submissionByAssignment[a._id.toString()];
            const passed = sub?.status === 'graded' && sub.grade >= CERTIFICATE_PASS_THRESHOLD;
            if (passed) passedCount++;
          });

          result[cId] = {
            eligible: passedCount === totalAssignments,
            totalAssignments,
            passedAssignments: passedCount,
            courseTitle: classDocMap[cId]?.title || 'Course'
          };
        }

        res.send(result);
      } catch (error) {
        // console.error('Error checking bulk certificate status:', error);
        res.status(500).send({ message: 'Failed to check certificate status', error: error.message });
      }
    });

    // GET: All submissions for a class, grouped by assignment (Teacher/Admin, ownership-checked)
    app.get('/submissions/class/:classId', verifyToken, verifyTeacherOrAdmin, async (req, res) => {
      try {
        const { classId } = req.params;
        const requesterEmail = req.decoded.email;

        if (!ObjectId.isValid(classId)) {
          return res.status(400).send({ message: 'Invalid Class ID' });
        }

        const targetClass = await classCollection.findOne({ _id: new ObjectId(classId) });
        if (!targetClass) {
          return res.status(404).send({ message: 'Class not found' });
        }

        const requester = await usersCollection.findOne({ email: requesterEmail });
        const isOwner = targetClass.teacherEmail === requesterEmail || targetClass.email === requesterEmail;
        if (requester?.role !== 'admin' && !isOwner) {
          return res.status(403).send({ message: 'Forbidden: You can only view submissions for your own classes' });
        }

        const assignments = await assignmentsCollection.find({ classId: classId.toString() }).toArray();
        const submissions = await submissionsCollection
          .find({ classId: classId.toString() })
          .sort({ submittedAt: -1 })
          .toArray();

        const assignmentTitleMap = {};
        assignments.forEach(a => { assignmentTitleMap[a._id.toString()] = a.title; });

        const enriched = submissions.map(s => ({
          ...s,
          assignmentTitle: assignmentTitleMap[s.assignmentId] || 'Unknown Assignment'
        }));

        res.send({
          classTitle: targetClass.title,
          totalAssignments: assignments.length,
          submissions: enriched
        });
      } catch (error) {
        // console.error('Error fetching class submissions:', error);
        res.status(500).send({ message: 'Failed to fetch submissions', error: error.message });
      }
    });

    app.get('/classes/:id/related', async (req, res) => {
      try {
        const classId = req.params.id;

        const idConditions = [{ _id: classId }];
        if (ObjectId.isValid(classId)) idConditions.push({ _id: new ObjectId(classId) });

        const targetCourse = await classCollection.findOne({ $or: idConditions });
        if (!targetCourse) {
          return res.status(404).send({ message: 'Course not found' });
        }

        // Fallback: if this course has no embedding yet (e.g. created before this feature),
        // just return other accepted courses in the same category
        if (!targetCourse.embedding) {
          const fallback = await classCollection
            .find({ status: 'accepted', category: targetCourse.category, _id: { $ne: targetCourse._id } })
            .limit(4)
            .toArray();
          return res.send(fallback);
        }

        const candidates = await classCollection
          .find({ status: 'accepted', _id: { $ne: targetCourse._id }, embedding: { $exists: true } })
          .toArray();

        const scored = candidates
          .map((c) => ({
            course: c,
            score: cosineSimilarity(targetCourse.embedding, c.embedding)
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 4)
          .map((entry) => entry.course);

        res.send(scored);
      } catch (error) {
        // console.error('Error fetching related courses:', error);
        res.status(500).send({ message: 'Failed to fetch related courses', error: error.message });
      }
    });

    // NEW: Personalized recommendations based on a student's enrollment history
    app.get('/recommendations/personalized', verifyToken, async (req, res) => {
      try {
        const userEmail = req.decoded.email;

        // 1. Get this student's enrolled classIds
        const enrollments = await enrollmentCollection
          .find({ userEmail })
          .toArray();

        const enrolledClassIds = [...new Set(enrollments.map(e => e.classId?.toString()).filter(Boolean))];

        // Cold start: no enrollment history yet -> fall back to trending courses
        if (enrolledClassIds.length === 0) {
          const trending = await classCollection
            .find({ status: 'accepted' })
            .sort({ totalEnrollment: -1 })
            .limit(4)
            .toArray();
          return res.send(trending);
        }

        // 2. Fetch embeddings for the enrolled courses
        const idConditions = enrolledClassIds.map(id => {
          const conditions = [{ _id: id }];
          if (ObjectId.isValid(id)) conditions.push({ _id: new ObjectId(id) });
          return conditions;
        }).flat();

        const enrolledCourses = await classCollection
          .find({ $or: idConditions, embedding: { $exists: true } })
          .toArray();

        const vectors = enrolledCourses.map(c => c.embedding).filter(Boolean);

        if (vectors.length === 0) {
          const trending = await classCollection
            .find({ status: 'accepted' })
            .sort({ totalEnrollment: -1 })
            .limit(4)
            .toArray();
          return res.send(trending);
        }

        // 3. Average the embeddings into one "interest vector"
        const dim = vectors[0].length;
        const sum = new Array(dim).fill(0);
        vectors.forEach(vec => {
          for (let i = 0; i < dim; i++) sum[i] += vec[i];
        });
        const interestVector = sum.map(v => v / vectors.length);

        // 4. Compare against all other accepted courses
        const candidates = await classCollection
          .find({
            status: 'accepted',
            embedding: { $exists: true },
            _id: { $nin: enrolledCourses.map(c => c._id) }
          })
          .toArray();

        const scored = candidates
          .map(c => ({ course: c, score: cosineSimilarity(interestVector, c.embedding) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 4)
          .map(entry => entry.course);

        res.send(scored);
      } catch (error) {
        // console.error('Error generating personalized recommendations:', error);
        res.status(500).send({ message: 'Failed to fetch personalized recommendations', error: error.message });
      }
    });

    // GET: Featured instructors with live course/enrollment stats, for the About page
    app.get('/instructors/featured', async (req, res) => {
      try {
        const LIMIT = 6;

        const result = await classCollection.aggregate([
          { $match: { status: 'accepted' } },
          {
            $group: {
              _id: { $ifNull: ['$teacherEmail', '$email'] },
              name: { $first: { $ifNull: ['$teacherName', '$name'] } },
              image: { $first: '$teacherImage' },
              title: { $first: '$instructorDetails.title' },
              bio: { $first: '$instructorDetails.bio' },
              totalCourses: { $sum: 1 },
              totalStudents: { $sum: { $ifNull: ['$totalEnrollment', 0] } },
              avgRating: { $avg: { $ifNull: ['$rating', 0] } }
            }
          },
          { $match: { _id: { $ne: null } } },
          { $sort: { totalStudents: -1, totalCourses: -1 } },
          { $limit: LIMIT }
        ]).toArray();

        res.send(result.map(r => ({
          email: r._id,
          name: r.name || 'Instructor',
          image: r.image || '',
          title: r.title || '',
          bio: r.bio || '',
          totalCourses: r.totalCourses,
          totalStudents: r.totalStudents,
          avgRating: Number((r.avgRating || 0).toFixed(1))
        })));
      } catch (error) {
        // console.error('Error fetching featured instructors:', error);
        res.status(500).send({ message: 'Failed to fetch featured instructors', error: error.message });
      }
    });


    // await db.command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (error) {
    console.error("MongoDB Connection Failed:", error);
  }
}

run().catch(console.dir);

// Root Health Check Route
app.get('/', (req, res) => {
  res.send('LMS System Running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = app;