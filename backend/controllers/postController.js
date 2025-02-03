const Post = require('../models/Post');

exports.createPost = async (req, res) => {
    const { userId, content, image } = req.body;
    try {
        const post = new Post({ userId, content, image });
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
