const Post = require('../models/Post');

exports.createPost = async (req, res) => {
    const { userId, content, image } = req.body;
    try {
        const post = new Post({ userId: req.userId, content, image });
        await post.save();
        res.status(201).json(post);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.getPosts = async (req, res) => {
    try {
        const posts = await Post.find().populate('userId', 'username profilePicture');
        res.json(posts);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// New method to get a single post by ID
exports.getPostById = async (req, res) => {
    try {
        const post = await Post.findById(req.params.id).populate('userId', 'username profilePicture');
        if (!post) return res.status(404).json({ error: 'Post not found' });
        res.json(post);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};