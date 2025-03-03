const Post = require('../models/Post');

exports.createPost = async (req, res) => {
    const { content, image, tags } = req.body;
    try {
        const post = new Post({ userId: req.userId, content, image, tags });
        await post.save();
        res.status(201).json(post);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Get user statistics (post count and comment count)
exports.getUserStats = async (req, res) => {
    try {
        const userId = req.params.userId;
        const postCount = await Post.getPostCount(userId);
        const commentCount = await Post.getCommentCount(userId);
        res.json({ postCount, commentCount });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Search posts by content or tags
exports.searchPosts = async (req, res) => {
    try {
        const { query, tags } = req.query;
        let searchQuery = {};

        if (query) {
            searchQuery.$or = [
                { content: { $regex: query, $options: 'i' } },
                { 'comments.text': { $regex: query, $options: 'i' } }
            ];
        }

        if (tags) {
            const tagArray = tags.split(',').map(tag => tag.trim());
            searchQuery.tags = { $in: tagArray };
        }

        const posts = await Post.find(searchQuery)
            .populate('userId', 'username profilePicture')
            .populate('comments.userId', 'username profilePicture')
            .sort({ createdAt: -1 });

        res.json(posts);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.getPosts = async (_, res) => {
    try {
        const posts = await Post.find()
            .populate('userId', 'username profilePicture')
            .populate('comments.userId', 'username profilePicture');
        res.json(posts);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// New method to get a single post by ID
exports.getPostById = async (req, res) => {
    try {
        const post = await Post.findById(req.params.id).populate('userId', 'username profilePicture').populate('comments.userId', 'username profilePicture');
        if (!post) return res.status(404).json({ error: 'Post not found' });
        res.json(post);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Add a comment to a post
exports.addComment = async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: 'Comment text is required' });
        }
        
        const post = await Post.findById(req.params.id);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        // Create the comment object
        const comment = {
            userId: req.userId,
            text,
            createdAt: new Date()
        };
        
        // Add the comment to the post's comments array
        post.comments.push(comment);
        
        // Save the updated post
        await post.save();
        
        // Populate the user information for the new comment and return it
        const updatedPost = await Post.findById(post._id)
            .populate('userId', 'username profilePicture')
            .populate('comments.userId', 'username profilePicture');
        
        // Return only the newly added comment with populated user information
        const newComment = updatedPost.comments[updatedPost.comments.length - 1];
        res.status(201).json(newComment);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};