//==============================================================================================
//
// This file is part of Chromed.
//
// Chromed is free software: you can redistribute it and/or modify it under the terms of the GNU
// General Public License as published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Chromed is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with Chromed.  If not,
// see <http://www.gnu.org/licenses/>.
//
// Copyright (c) 2011 Pat M. Lasswell
//
//==============================================================================================


//==============================================================================================
// 
// Channel API
// 
//   Each channel has an execution environment that is essentially the global javascript
//   environment with three additions: 'Channel', 'channel', and 'script'.
//
//   Channel constructs new channel objects.  In the root channel, which is attached to
//   background.html, Channel has several class methods:
//
//     create(name, url, channel_type)
//
//       Creates a new tab viewing url and opens a channel into it. The name given can be used
//       later to refer to the channel in the methods install, get_url, and close.  channel_type
//       is optional and defaults to 'default'.  Use add_installer to define new channel types.
//
//     install(name, channel_type)
//
//       Reinstalls a channel in a tab that formerly had the named channel. channel_type is
//       optional and defaults to 'default'.  This is useful where an event on the page triggered
//       a reload or a new document to be loaded.  This reestablishes a connection with the tab.
//
//     get_url(name)
//
//       Returns the url currently displayed in the tab associated with name.  The channel may or
//       may not be connected.
//
//     close(name, callback)
//
//       Closes the tab and removes the channel. If callback is provided, it will be called by the
//       chrome.tabs.remove method.  See http://code.google.com/chrome/extensions/tabs.html.
//
//     add_installer(type, script)
//
//       Defines a new channel installer.  Script should be a string containing executable
//       javascript. The script should evaluate to a function of three arguments: an evaluator,
//       the name of the new channel, and the url of the websocket server. While it is not exactly
//       necessary that the initializer open a new channel (as that can certainly be done later
//       with install), it is intended that it should perform a superset of the tasks that
//       install_channel does.  See install_channel below.
//
//     remove_installer(type)
//
//       Removes a previously defined installer.
//
//   Channel instances also have several methods that are probably not of general utility. One
//   that deserves mention is the send method:
//
//     send(data)
//
//       Sends its argument (as a text string) to the websocket server.
//
//==============================================================================================


(function (channel_eval) {

  function install_channel(channel_eval, name, socket_url) {
    if (window.Channel === undefined) {
      function Channel(name, socket_url) {
	this.name = name
	this.socket_url = socket_url
	this.socket = null
	this.delay_idx = 0

	// Implementing dispatch this way (as opposed to a prototype member) provides a unique
	// closure for the evaluator of each Channel instance.
	this.eval = channel_eval.bind(null, this)
      }

      window.Channel = Channel

      // Retries on failure to connect occur at progressively longer intervals. If a connection
      // has still not been made by the time the retry delay is the last value in the sequence, then 
      // the last value is used for the delay until a connection is made.
      Channel.retry_delays = [0, 1, 2, 4, 8, 15, 30, 60, 120, 240]

      // Once an attempt to connect is initiated, a timeout is set so that one second later the
      // following function is called.  If after on second the timeout has not been cancelled,
      // then it is assumed that the connection was successful, and the retry delay interval is
      // restored to its original value. 
      Channel.prototype.resetDelay = function resetDelay() {
	console.log('resetting retries for channel ' + this.name)
	this.delay_idx = 0
      }

      Channel.prototype.connect = function connect() {
	console.log('connecting ' + this.name + ' (delay ' + Channel.retry_delays[this.delay_idx] + 's)')
	window.setTimeout(this.open_socket.bind(this), Channel.retry_delays[this.delay_idx] * 1000)
      }

      Channel.prototype.open_socket = function open_socket() {
	this.resetter = window.setTimeout(this.resetDelay.bind(this), 1000)
	this.socket = new WebSocket(this.socket_url)
	this.socket.addEventListener('close', this.socket_closed.bind(this))
	this.socket.addEventListener('message', this.message_respondent.bind(this))
      }

      Channel.prototype.message_respondent = function message_respondent(evt) {
	var script = evt.data
	console.log('message[' + this.name + ']: ' + script)
	this.eval(script)
      }

      Channel.prototype.send = function send(data) { this.socket.send(data) }

      // Any failure in setup or subsequently will ultimately close the socket and end up in this
      // function. Since this function calls connect, there is an implicit asynchronous loop:
      // connect, open_socket, close, connect, .... 
      Channel.prototype.socket_closed = function socket_closed() {
	window.clearTimeout(this.resetter)
	this.socket = null
	this.delay_idx = Math.min(this.delay_idx+1, Channel.retry_delays.length-1)
	console.log('channel ' + this.name + ' closed, attempting to reopen')
	this.connect()
      }
    }

    var channel = new Channel(name, socket_url)
    channel.connect()
    return channel
  }

  var socket_url = localStorage['socket_url'] || "ws://localhost:8080/chromed-proxy"

  // Open the root channel in this page (background.html in the chromed extension).
  window.channel = install_channel(channel_eval, 'root', socket_url)

  // tabs is a map from a channel name to either the string 'waiting' if the channel
  // is in the process of being opened, or the chrome tab containing the page
  // into which the channel opens.  See create_channel, get_channel_url and close_channel.
  var tabs = {}

  // Housekeeping
  chrome.tabs.onRemoved.addListener(function(tab_id, info) {
    for (var name in tabs)
      if (tabs[name] != 'waiting' && tabs[name].id == tab_id) {
	console.log('channel removed via onRemoved')
	delete tabs[name]
      }
  })

  // installers is a dictionary of scripts.  Each installer is a block of executable javascript
  // that, when evaluated in the context of the new page, should set up the channel and perform
  // initialization to support the intended use of the channel.  Installers have some peculiar
  // constraints: for an installer i, String(i) must result in a block of code that evaluates to a
  // function of three arguments. See install_channel above for an example. Futhermore, since the
  // code is executed in a different page context -- i.e., not the background page, but some newly
  // created page -- it must be self-contained, or at most, dependent on things that will reliably
  // be on the target page.  See channel_type in Channel.create and Channel.install.

  var installers = { 'default': install_channel }

  Channel.prototype.add_installer = function add_installer(type, script) {
    installers[type] = script
    return 'ok'
  }

  Channel.prototype.remove_installer = function remove_installer(type, script) {
    delete(installers[type])
    return 'ok'
  }

  // The following functions manage the relationship between a named channel and a tab.  This is
  // useful if the result of a channel request changes the viewed page and destroys the channel.
  // The tabs dictionary allows the chromed client to determine what url the associated tab is
  // viewing and to reinstall the channel, if necessary.  They are only available on the root
  // channel in the background page.  That way, the Channel instances on other pages cannot
  // accidentally be used as if they were the root page, likely causing some confusion.


  // Create a new tab viewing 'url'.  Install a channel driver into the new tab and
  // register it under 'name' in the tabs dictionary.
  Channel.create = function create(name, url, channel_type) {
    if (tabs[name]) return { error: "channel '" + name + "' already exists" }

    channel_type = channel_type != undefined ? channel_type : 'default'
    tabs[name] = 'waiting'
    chrome.tabs.create({ url: url }, function(tab) { tabs[name] = tab, Channel.install(name, channel_type) })

    console.log('channel created: ' + name)
    return 'ok'
  }


  // In the case that the user or a script has navigated away from the page containing the channel
  // driver, this function can be used to reinstall the driver.  Calling this function on a channel 
  // which still has a driver installed could result in 
  Channel.install = function install(name, channel_type) {
    if (!tabs[name])             return { error: "channel '" + name + "' does not exist" }
    if (tabs[name] == 'waiting') return { error: "channel '" + name + "' has not been created yet" }

    var args = [channel_eval, JSON.stringify(name), JSON.stringify(socket_url)].join(', ')
    try { chrome.tabs.executeScript(tabs[name].id, { code: '(' + installers[channel_type] + ')(' + args + ')' }) }
    catch(e) { return { error: "channel '" + name + "' has no tab" } }
    console.log('Channel installed: ' + name)
    return 'ok'
  }


  // Returns the url currently being viewed at the tab associated with the named channel.  It need not be 
  // the same url given to create channel, as the user or a script could have directed the browser to view
  // a different one.
  Channel.get_url = function get_url(name) {
    if (!tabs[name])             return { error: "channel '" + name + "' does not exist" }
    if (tabs[name] == 'waiting') return { error: "channel '" + name + "' has not been created yet" }

    try { return tabs[name].url }
    catch(e) { return { error: "channel '" + name + "' has no tab" } }
  }


  // Shuts down the given channel, removing its associated tab.
  Channel.close = function close(name, callback) {
    if (!tabs[name])             return { error: "channel '" + name + "' does not exist" }
    if (tabs[name] == 'waiting') return { error: "channel '" + name + "' has not been created yet" }

    try {
      var tab = tabs[name]
      delete tabs[name]
      chrome.tabs.remove(tab.id, callback)
      console.log('channel deleted: ' + name)
      return 'ok'
    }
    catch(e) { return { error: "channel '" + name + "' had no tab" } }
  }

})(function(channel, script) {
  // This function is declared this way (as opposed to conventionally in the body of the enclosing
  // function) to keep the namespace for the evaluator as clean as possible.  Similarly, the
  // function itself would be more conventionally phrased with a 'var result = ...' instead of the
  // inline anonymous function call.
  //
  // This phrasing adds only 'channel' and 'script' to the execution environment.  (Additionally,
  // the default installer adds 'Channel'.)
  channel.send((function () { try { return JSON.stringify(eval(script)) } catch(e) { return e } })())
})


// Local Variables:
// mode: javascript
// c-basic-offset: 2
// indent-tabs-mode: nil
// fill-column: 98
// End:
