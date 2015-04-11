var child_process = require('child_process');
var fs = require('fs');
var util = require('util');

var AWS = require('aws-sdk');
var async = require('async');
var uuid = require('uuid');

var config = require('./config');
var scaleFilter = "scale='min(" + config.videoMaxWidth.toString() + "\\,iw):-2'";

var s3 = new AWS.S3();

function downloadStream(bucket, file, context) {
	var req = s3.getObject({
		Bucket: bucket,
		Key: file
	});

	req.on('error', function(res) {
		return context.done('S3 download error:', res);
	});

	return req.createReadStream();
}

function uploadFile(cb, filename, bucket, key, contentType) {
	s3.putObject({
		Bucket: bucket,
		Key: key,
		Body: fs.createReadStream(filename),
		ContentType: contentType
	}, cb);
}

function getffmpeg(dstBucket, keyPrefix, description, context) {
	console.log('starting ffmpeg');

	var ffmpeg = child_process.execFile(
		process.env.ffmpeg || '/tmp/ffmpeg',
		[
			'-y',
			'-loglevel', 'warning',
			'-threads', '2',
			'-i', '-',
			'-vf', scaleFilter,
			'-movflags', '+faststart',
			'-metadata', 'description=' + description,
			'out.mp4',
			'-vf', 'thumbnail',
			'-vf', scaleFilter,
			'-vframes', '1',
			'out.png'
		],
		{
			cwd: '/tmp',
			stdio: [null, null, null, 'pipe']
		}
	);

	ffmpeg.on('exit', function (code, signal) {
		console.log('ffmpeg done');

		if (code)
			return context.done('ffmpeg Error', 'code:', code, 'signal:', signal);

		async.parallel(
			[
				function (callback) {
					console.log('uploading mp4');
					uploadFile(callback, '/tmp/out.mp4', dstBucket, keyPrefix + '.mp4', 'video/mp4')
				},
				function (callback) {
					console.log('uploading png');
					uploadFile(callback, '/tmp/out.png', dstBucket, keyPrefix + '.png', 'image/png')
				}
			],
			function (err, results) {
				console.log('Uploads finished', results);
				context.done(err);
			}
		);
	});

	return ffmpeg;
}

function uuid2shorturl(id) {
	return new Buffer(uuid.parse(id))
		.toString('base64')
		.substring(0, 22)
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

exports.handler = function(event, context) {
	// http://stackoverflow.com/questions/27708573/aws-lambda-making-video-thumbnails
	child_process.exec('cp /var/task/ffmpeg /tmp/.; chmod 755 /tmp/ffmpeg;', function(error, stdout, stderr) {
		if (error)
			return context.done('Error', error);

		console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
		var srcBucket = event.Records[0].s3.bucket.name;
		var srcKey = decodeURIComponent(event.Records[0].s3.object.key);
		var dstBucket = config.destinationBucket;
		var keyPrefix = srcKey.replace(/\.[^/.]+$/, '');

		// Key structure on source bucket is 3 folders deep with a UUID filename
		var shortlink = config.linkPrefix + uuid2shorturl(keyPrefix.split('/')[2]);

		console.log('starting download');

		var readStream = downloadStream(srcBucket, srcKey, context);
		readStream.pipe(getffmpeg(dstBucket, keyPrefix, shortlink, context).stdio[0]);
	});
};